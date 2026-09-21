/**
 * Latent Protocol plugin for MiMo Code.
 *
 * MiMo discovers TypeScript plugins from ~/.config/mimocode/plugins (or
 * ~/.mimocode, ~/.mimo — see cli/src/surfaces/mimo.ts) and transpiles each
 * file in its own runtime with no module resolution across sibling files.
 * This file is therefore deliberately standalone: it must not import the
 * Latent CLI bundle, `openclaw-plugin`, or depend on the caller's cwd. The
 * sanitisation and URL-safety helpers below are a condensed copy of
 * `openclaw-plugin/src/lib/{sanitize,footer}.ts` — keep the three in sync.
 *
 * Deliberately NOT implemented: click-through billing. The marketplace's
 * ad-click endpoint has no signed token yet (see docs/SECURITY_HARDENING.md,
 * C1 / S6) — any client that builds a click-redirect URL today is trusting an
 * unauthenticated, forgeable endpoint. This plugin renders the advertiser's
 * `cta_url` as a plain safe link and only bills the impression; add
 * click tracking here once S6 ships a verifiable `click_token`.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SERVER = "https://api.latentprotocol.xyz";
const REQUEST_TIMEOUT_MS = 2_000;
const AGENT = "mimo";
const SURFACE = "response_footer";

/* ---------------------------------------------------------------------- *
 * Ad-copy sanitisation (mirrors openclaw-plugin/src/lib/sanitize.ts).
 * Advertiser text is untrusted and lands in a chat message the user reads —
 * strip ANSI/control sequences and bidi overrides, and neutralise raw `[`/`]`
 * so a body/cta_text can't forge a second, unvalidated markdown link.
 * ---------------------------------------------------------------------- */
/* eslint-disable no-control-regex */
const ESC_SEQ =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]|\x1b[@-_]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;
const MD_LINK_BRACKETS: Record<string, string> = { "[": "［", "]": "］" };
const AD_LIMITS = { body: 140, cta_text: 24 } as const;

function sanitizeAdText(input: unknown, max: number): string {
  let s = String(input ?? "");
  s = s.replace(ESC_SEQ, "").replace(CONTROL, " ").replace(BIDI, "");
  s = s.replace(/[[\]]/g, (c) => MD_LINK_BRACKETS[c]!);
  s = s.replace(/\s+/g, " ").trim();
  if (max > 0 && s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  return s;
}

/** https-only, no embedded userinfo, no control chars — mirrors footer.ts's isSafeUrl. */
function isSafeUrl(url: string): boolean {
  if (typeof url !== "string" || !url.startsWith("https://")) return false;
  const hasControlChar = [...url].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
  if (hasControlChar) return false;
  try {
    const parsed = new URL(url);
    return parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------- *
 * Config + device id — read the same files every other surface writes to.
 * ---------------------------------------------------------------------- */
interface Settings {
  wallet: string;
  server: string;
  frequency: number;
}

function latentConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".latent-protocol", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

function enabled(config: Record<string, unknown>): boolean {
  const env = process.env.ADS_ENABLED;
  if (env !== undefined) return !["false", "0", "no"].includes(env.toLowerCase());
  return config.enabled !== false;
}

function settings(): Settings | null {
  const config = latentConfig();
  const wallet = process.env.ADS_WALLET || (typeof config.wallet === "string" ? config.wallet : "");
  if (!enabled(config) || !wallet) return null;

  const rawServer = process.env.ADS_SERVER || (typeof config.server === "string" ? config.server : DEFAULT_SERVER);
  const frequency = Number(config.frequency ?? 1);
  return {
    wallet,
    server: rawServer.replace(/\/+$/, ""),
    frequency: Number.isFinite(frequency) && frequency > 0 ? Math.floor(frequency) : 1,
  };
}

/**
 * Stable per-install identifier shared with every other surface (Claude
 * Code, Codex, OpenClaw, the VS Code extension). Not a secret — a
 * correlation signal so the server can cap per physical machine, not only
 * per (free, instantly-mintable) wallet. Best-effort: never throws.
 */
function deviceId(): string {
  const file = join(homedir(), ".latent-protocol", "device_id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // fall through to create
  }
  const id = randomBytes(16).toString("hex");
  try {
    mkdirSync(join(homedir(), ".latent-protocol"), { recursive: true });
    writeFileSync(file, id, { flag: "wx" });
    return id;
  } catch {
    try {
      const winner = readFileSync(file, "utf8").trim();
      if (winner) return winner;
    } catch {
      // FS unavailable — soft signal, not an identity guarantee.
    }
    return id;
  }
}

/* ---------------------------------------------------------------------- *
 * Ad marketplace calls — fail-open, 2s hard timeout, 30s cache.
 * ---------------------------------------------------------------------- */
interface Ad {
  ad_id?: string;
  id?: string;
  title?: string;
  body?: string;
  cta_text?: string;
  cta_url?: string;
  earn_amount?: number;
  impression_token?: string;
}

const CACHE_TTL_MS = 30_000;
let cachedAd: Ad | null = null;
let cachedAt = 0;
let responseCount = 0;

async function postJson(url: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

async function fetchAd(config: Settings): Promise<Ad | null> {
  const now = Date.now();
  if (cachedAd && now - cachedAt < CACHE_TTL_MS) return cachedAd;
  const resp = await postJson(`${config.server}/ad/request`, {
    user_wallet: config.wallet,
    agent: AGENT,
    // Category slug only — the response text never leaves the machine.
    context: "coding",
    surface: SURFACE,
    device_id: deviceId(),
  });
  if (!resp || !resp.ok) return null;
  try {
    const ad = (await resp.json()) as Ad;
    if (!ad || !(ad.ad_id || ad.id)) return null;
    cachedAd = ad;
    cachedAt = now;
    return ad;
  } catch {
    return null;
  }
}

async function reportImpression(ad: Ad, config: Settings): Promise<void> {
  const adId = ad.ad_id ?? ad.id ?? "";
  const token = ad.impression_token ?? "";
  if (!adId) return;
  await postJson(`${config.server}/ad/impression`, {
    ad_id: adId,
    user_wallet: config.wallet,
    token,
  });
}

/** Markdown footer appended to the completed response. */
function formatFooter(ad: Ad): string {
  const body = sanitizeAdText(ad.body || ad.title, AD_LIMITS.body) || "Sponsored";
  const cta = sanitizeAdText(ad.cta_text, AD_LIMITS.cta_text) || "Learn more";
  const earn = ad.earn_amount ?? 0;
  const url = typeof ad.cta_url === "string" ? ad.cta_url : "";
  const ctaLine = isSafeUrl(url) ? `[${cta} →](${url})` : `${cta} →`;
  return `\n\n---\n💰 **Sponsored:** ${body}  \n${ctaLine}  \n_+$${earn} USDC earned_`;
}

/** MiMo plugin entry point. `experimental.text.complete` is invoked when the
 *  response is complete and lets a plugin append visible, labelled content. */
const plugin = async () => ({
  "experimental.text.complete": async (_input: unknown, output: { text: string }) => {
    const config = settings();
    if (!config) return;
    responseCount += 1;
    if (responseCount % config.frequency !== 0) return;

    const ad = await fetchAd(config);
    if (!ad) return;

    output.text += formatFooter(ad);
    await reportImpression(ad, config);
  },
});

// LATENT_PROTOCOL_MIMO_PLUGIN
export default plugin;
