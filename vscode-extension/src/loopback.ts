/**
 * Loopback privacy boundary.
 *
 * A tiny HTTP server bound to 127.0.0.1 with a random token in the URL path.
 * The only thing injected code (in the agent webview) ever talks to is this
 * loopback — the wallet/server config never enters the webview (browser)
 * context. The loopback owns the whole billing bridge: category-slug ad
 * requests, signed impressions (carrying device_id + honest view time), and
 * clicks as a 302 chain (GET /click → server GET /ad/click → advertiser URL).
 * Identity (port+token) is persisted so a window reload keeps the same
 * baked-in URL working; the adId → click-token map is persisted too (a click
 * can land after a reload).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deviceId, loadConfig } from "./config.js";
import { recordServerResult, shouldServe } from "./health.js";
import { inlineIcon } from "./icon.js";

export interface LoopbackIdentity {
  port: number;
  token: string;
}

export interface FunnelEvent {
  event: string;
  adId: string;
  at: number;
}

interface AdRecord {
  clickToken: string;
  ctaUrl: string;
}

/** Keep the last N ad records (a click can land well after the rotation). */
const AD_STORE_MAX = 20;

/** Local funnel ring-buffer size (test/diagnose surface). */
const EVENT_BUFFER_MAX = 200;

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

function adStoreFile(agent: string): string {
  return join(homedir(), ".latent-protocol", `loopback-${agent}-ads.json`);
}

function loadAdStore(agent: string): Record<string, AdRecord> {
  try {
    return JSON.parse(readFileSync(adStoreFile(agent), "utf8")) as Record<string, AdRecord>;
  } catch {
    return {};
  }
}

function saveAdStore(agent: string, store: Record<string, AdRecord>): void {
  try {
    const entries = Object.entries(store).slice(-AD_STORE_MAX);
    mkdirSync(join(homedir(), ".latent-protocol"), { recursive: true });
    writeFileSync(adStoreFile(agent), JSON.stringify(Object.fromEntries(entries)));
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

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

export class Loopback {
  private server: Server | null = null;
  private token = "";
  private port = 0;
  /** Recent funnel events. The ad server has no /metric ingest yet (view-time
   * gating rides on /ad/impression's displayed_ms), so these stay local —
   * telemetry for the test/diagnose surface, never forwarded upstream. */
  private events: FunnelEvent[] = [];

  constructor(private readonly agent: string, private readonly getCategory: () => string) {}

  /** Base URL the injected block calls, e.g. http://127.0.0.1:5123/cb/<token> */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/cb/${this.token}`;
  }

  /** Last funnel events seen (for the test/diagnose surface). */
  recentEvents(): FunnelEvent[] {
    return [...this.events];
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

  private recordEvent(body: { event?: string; adId?: string }): void {
    this.events.push({ event: body.event || "unknown", adId: body.adId || "", at: Date.now() });
    if (this.events.length > EVENT_BUFFER_MAX) this.events.splice(0, this.events.length - EVENT_BUFFER_MAX);
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

      // Click navigation is exempt from the enabled/killswitch gate below: a
      // human is mid-click, so the 302 chain must unwind regardless (the
      // server-side routes already withhold the credit when killed).
      if (route === "click" && req.method === "GET") {
        const adId = url.searchParams.get("adId") || "";
        if (!adId) return send(res, 404, { error: "missing adId" });
        const rec = loadAdStore(this.agent)[adId];
        const t = rec?.clickToken ? `&t=${encodeURIComponent(rec.clickToken)}` : "";
        // Even with no stored token the server still redirects (it withholds
        // only the credit) and falls back to the stored cta_url as a last
        // resort — navigation must never dead-end.
        const chain = `${cfg.server}/ad/click?ad=${encodeURIComponent(adId)}&w=${encodeURIComponent(cfg.wallet)}${t}`;
        return redirect(res, rec?.ctaUrl && !cfg.server ? rec.ctaUrl : chain);
      }

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
        const adId = (ad.ad_id as string) || (ad.id as string) || "";
        const clickToken = (ad.click_token as string) || "";
        const ctaUrl = (ad.cta_url as string) || "";
        if (adId) {
          const store = loadAdStore(this.agent);
          store[adId] = { clickToken, ctaUrl };
          saveAdStore(this.agent, store);
        }
        return send(res, 200, {
          ad: {
            text: (ad.body as string) || (ad.title as string) || "",
            url: ctaUrl,
            adId,
            token: (ad.impression_token as string) || "",
            clickHref: adId ? `${this.baseUrl}/click?adId=${encodeURIComponent(adId)}` : "",
            iconUrl: typeof ad.image_url === "string" ? await inlineIcon(ad.image_url, cfg.server) : "",
          },
        });
      }

      if (route === "impression" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          adId?: string;
          token?: string;
          displayedMs?: number;
          surface?: string;
        };
        await fetch(`${cfg.server}/ad/impression`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ad_id: body.adId || "",
            user_wallet: cfg.wallet,
            token: body.token || "",
            agent: this.agent,
            surface: body.surface || "spinner",
            context: this.getCategory() || "",
            // device_id is re-sent here (the API is stateless) so the
            // impressions row carries it for the per-device daily cap.
            device_id: deviceId(),
            ...(typeof body.displayedMs === "number"
              ? { displayed_ms: Math.round(body.displayedMs) }
              : {}),
          }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => undefined);
        return send(res, 200, { ok: true });
      }

      if (route === "click" && req.method === "POST") {
        // Best-effort billing twin for the href navigation (which is the real
        // click path and already credits via GET /ad/click). The server's
        // replay guard makes the double-fire harmless.
        const body = JSON.parse((await readBody(req)) || "{}") as { adId?: string; surface?: string };
        const rec = loadAdStore(this.agent)[body.adId || ""];
        if (rec?.clickToken) {
          await fetch(`${cfg.server}/ad/click`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ad_id: body.adId || "",
              user_wallet: cfg.wallet,
              token: rec.clickToken,
              agent: this.agent,
              surface: body.surface || "spinner",
              context: this.getCategory() || "",
            }),
            signal: AbortSignal.timeout(3000),
          }).catch(() => undefined);
        }
        return send(res, 200, { ok: !!rec?.clickToken });
      }

      if (route === "metric" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { event?: string; adId?: string };
        this.recordEvent(body);
        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: "not found" });
    } catch {
      recordServerResult(false);
      send(res, 200, { ad: null });
    }
  }
}
