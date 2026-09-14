/**
 * Loopback privacy boundary.
 *
 * A tiny HTTP server bound to 127.0.0.1 with a random token in the URL path.
 * The only thing injected code (in the agent webview) ever talks to is this
 * loopback — the wallet/server config never enters the webview (browser)
 * context. The loopback proxies category-slug ad requests to the Latent ad
 * server. Identity (port+token) is persisted so a window reload keeps the same
 * baked-in URL working.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deviceId, loadConfig } from "./config.js";
import { recordServerResult, shouldServe } from "./health.js";

export interface LoopbackIdentity {
  port: number;
  token: string;
}

function identityFile(agent: string): string {
  return join(homedir(), ".latent-protocol", `loopback-${agent}.json`);
}

function loadIdentity(agent: string): LoopbackIdentity | null {
  try {
    return JSON.parse(readFileSync(identityFile(agent), "utf8")) as LoopbackIdentity;
  } catch {
    return null;
  }
}

function saveIdentity(agent: string, id: LoopbackIdentity): void {
  try {
    mkdirSync(join(homedir(), ".latent-protocol"), { recursive: true });
    writeFileSync(identityFile(agent), JSON.stringify(id));
  } catch {
    /* best-effort */
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    // The injected code runs in the webview origin; allow it to read our reply.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(data);
}

export class Loopback {
  private server: Server | null = null;
  private token = "";
  private port = 0;

  constructor(private readonly agent: string, private readonly getCategory: () => string) {}

  /** Base URL the injected block calls, e.g. http://127.0.0.1:5123/cb/<token> */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/cb/${this.token}`;
  }

  async start(): Promise<void> {
    const existing = loadIdentity(this.agent);
    this.token = existing?.token || randomBytes(16).toString("hex");

    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      const preferred = existing?.port ?? 0;
      // `once` so this fallback only fires for the initial listen() — a
      // later runtime error on the now-listening server must not retrigger
      // listen(0, ...) on an already-listening server (ERR_SERVER_ALREADY_LISTEN).
      this.server!.once("error", () => {
        this.server!.listen(0, "127.0.0.1", () => resolve());
      });
      this.server!.listen(preferred, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    saveIdentity(this.agent, { port: this.port, token: this.token });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
      if (!url.pathname.startsWith(`/cb/${this.token}/`)) {
        send(res, 403, { error: "forbidden" });
        return;
      }
      const route = url.pathname.slice(`/cb/${this.token}/`.length);
      const cfg = loadConfig();
      if (!cfg.enabled || !cfg.wallet || !shouldServe().ok) {
        send(res, 200, { ad: null });
        return;
      }

      if (route === "ad" && req.method === "GET") {
        const category = url.searchParams.get("cat") || this.getCategory() || "general";
        const r = await fetch(`${cfg.server}/ad/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_wallet: cfg.wallet,
            agent: this.agent,
            context: category, // slug only
            surface: "spinner",
            tags: category ? [category] : [],
            session_id: this.token,
            device_id: deviceId(),
          }),
          signal: AbortSignal.timeout(3000),
        });
        recordServerResult(r.status < 500);
        if (!r.ok) return send(res, 200, { ad: null });
        const ad = (await r.json()) as Record<string, unknown>;
        return send(res, 200, {
          ad: {
            text: (ad.body as string) || (ad.title as string) || "",
            url: (ad.cta_url as string) || "",
            adId: (ad.ad_id as string) || (ad.id as string) || "",
            token: (ad.impression_token as string) || "",
          },
        });
      }

      if (route === "impression" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          adId?: string;
          token?: string;
          displayedMs?: number;
        };
        await fetch(`${cfg.server}/ad/impression`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ad_id: body.adId || "",
            user_wallet: cfg.wallet,
            token: body.token || "",
            ...(typeof body.displayedMs === "number"
              ? { displayed_ms: Math.round(body.displayedMs) }
              : {}),
          }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => undefined);
        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: "not found" });
    } catch {
      recordServerResult(false);
      send(res, 200, { ad: null });
    }
  }
}
