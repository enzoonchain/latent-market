import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  AGENT_CLAUDE_CODE,
  configDir,
  cacheFile,
  isEnabled,
  loadConfig,
  resolveServer,
  resolveWallet,
} from "./config.js";
import { randomUUID } from "node:crypto";
import { logImpression, requestAd, type Ad } from "./api.js";
import { classifyPrompt } from "./classify.js";
import { AD_LIMITS, sanitizeAdText } from "./sanitize.js";

// 10s rotation = CodeBacks parity (ADS_STATUSLINE_ROTATE still overrides).
const DEFAULT_ROTATE_SECONDS = 10;

// Don't bother billing before this much real on-screen time has accrued —
// the server's own MIN_VIEW_MS is authoritative (this is a client-side
// convenience threshold, not the enforcement point); mirrors the default so
// most impressions clear the server gate on the first attempt.
const MIN_DISPLAY_MS_BEFORE_BILL = 3000;
// Same cap `cli/src/adcache.ts` uses for the turn-hook surface — a stale
// cache from a much earlier, since-abandoned session shouldn't report hours
// of "dwell time".
const MAX_DISPLAY_MS = 600_000;

interface Cache {
  ad?: Ad;
  fetched_at?: number;
  /** Epoch ms when this cached ad was first served — the dwell-time baseline. */
  shown_at_ms?: number;
  session_id?: string;
  /**
   * True once POST /ad/impression has been sent for this cached ad.
   *
   * The cache is shared with the turn hook, which prefetches an ad at
   * turn-start using the classified prompt. That ad has not been billed by
   * anyone yet, so the flag — not the presence of the entry — is what decides
   * whether we still owe an impression.
   */
  billed?: boolean;
  /** Idempotency key for this ad's one impression — stable so a resend
   *  (flag lost, cache shared between terminals) dedupes server-side. */
  event_uuid?: string;
}

function isSafeUrl(url: string): boolean {
  if (typeof url !== "string" || !url.startsWith("https://")) return false;
  return [...url].every((c) => c.charCodeAt(0) >= 0x20 && c !== "\u001b" && c !== "\u0007");
}

function osc8Link(text: string, url: string): string {
  if (!isSafeUrl(url)) return text;
  return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;
}

export function formatStatusline(ad: Ad): string {
  // Advertiser-controlled — strip escape sequences / control chars before this
  // reaches the terminal. isSafeUrl() already guards the OSC 8 link target.
  const body = sanitizeAdText(ad.body || ad.title || "", AD_LIMITS.body);
  const ctaText = sanitizeAdText(ad.cta_text || "Learn more", AD_LIMITS.cta_text) || "Learn more";
  const ctaUrl = ad.cta_url || "";
  const earn = ad.earn_amount ?? 0;
  const cta = osc8Link(`${ctaText} →`, ctaUrl);
  return `\u001b[33m💰 Sponsored:\u001b[0m ${body}  ${cta}  \u001b[2m·  +$${earn} USDC\u001b[0m`;
}

function loadCache(): Cache {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8")) as Cache;
  } catch {
    return {};
  }
}

function saveCache(data: Cache): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    // Atomic swap — the cache is shared with the turn hook and (with several
    // terminals) other status-line processes; never leave a half-written file.
    const tmp = `${cacheFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, cacheFile());
  } catch {
    // best-effort
  }
}

function rotateSeconds(): number {
  const raw = process.env.ADS_STATUSLINE_ROTATE || String(DEFAULT_ROTATE_SECONDS);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ROTATE_SECONDS;
}

/**
 * A coarse category slug for ad targeting — never the raw prompt. The Claude
 * Code session payload carries the user's prompt; classify it locally (as the
 * turn hook does) so only the slug leaves the machine.
 */
function contextFromSession(session: Record<string, unknown>): string {
  for (const key of ["prompt", "user_message", "context"]) {
    const val = session[key];
    if (typeof val === "string" && val.trim()) return classifyPrompt(val);
  }
  return "general";
}

export async function render(session: Record<string, unknown> = {}): Promise<string> {
  const cfg = loadConfig();
  if (!isEnabled(cfg)) return "";
  const wallet = resolveWallet(cfg);
  if (!wallet) return "";

  const sessionId = String(session.session_id ?? "");
  const cache = loadCache();
  const now = Date.now() / 1000;

  const server = resolveServer(cfg);

  const fresh =
    cache.ad &&
    (now - (cache.fetched_at ?? 0)) < rotateSeconds() &&
    (cache.session_id ?? sessionId) === sessionId;

  // On Claude Code the status line is the only thing the user actually sees,
  // so it owns the impression: it bills for exactly what it puts on screen,
  // once, whoever fetched the ad. The turn hook deliberately does not bill
  // (see HOOK_OWNS_IMPRESSION in hook.ts) — if both did, one displayed ad
  // would be charged to the advertiser twice.
  //
  // Billing is deferred, not immediate: this script re-runs as a fresh
  // process on every status-line refresh tick (Claude Code polls it), so the
  // cache file is the only place elapsed on-screen time can live between
  // calls. We bill the FIRST poll where enough real dwell time has accrued
  // (see MIN_DISPLAY_MS_BEFORE_BILL) instead of the instant the ad is
  // fetched — mirrors the turn hook's already-real dwell reporting
  // (cli/src/hook.ts), which this surface previously didn't do at all.
  if (fresh && cache.ad) {
    const line = formatStatusline(cache.ad);
    if (!line) return "";
    if (!cache.billed) {
      if (cache.shown_at_ms === undefined) {
        // First time THIS status line has actually displayed this ad. It may
        // already sit in the cache because the turn hook prefetched it (see
        // writeStatuslineCache in hook.ts, which never sets shown_at_ms) —
        // that alone does not count as shown, only reaching this render()
        // call with a non-empty line does. Start the dwell clock now, and
        // mint the idempotency key up front so every later attempt to bill
        // this same occurrence (fresh-branch or the flush-on-rotation path
        // below) reuses one event_uuid.
        saveCache({ ...cache, shown_at_ms: Date.now(), event_uuid: cache.event_uuid ?? randomUUID() });
        return line;
      }
      const elapsedMs = Math.min(Date.now() - cache.shown_at_ms, MAX_DISPLAY_MS);
      if (elapsedMs >= MIN_DISPLAY_MS_BEFORE_BILL) {
        const eventId = cache.event_uuid ?? randomUUID();
        await logImpression(
          cache.ad.ad_id || cache.ad.id || "",
          wallet,
          cache.ad.impression_token || "",
          server,
          elapsedMs,
          eventId,
        );
        saveCache({ ...cache, billed: true, event_uuid: eventId });
      }
      // else: not enough elapsed time yet — try again on the next poll
      // while this ad is still fresh; no bill, no cache write.
    }
    return line;
  }

  // The cache is stale (rotation window elapsed) or foreign (session
  // changed). If it holds an ad THIS status line actually displayed
  // (shown_at_ms set) but never crossed the billing threshold above, flush
  // it now with whatever real elapsed time it actually got — the server's
  // own MIN_VIEW_MS is authoritative, this just reports the truth instead of
  // silently dropping a briefly-shown ad. An ad the turn hook merely
  // prefetched and this status line never got to render (shown_at_ms still
  // unset) must never be billed — nobody saw it.
  if (cache.ad && !cache.billed && cache.shown_at_ms !== undefined) {
    const staleAdId = cache.ad.ad_id || cache.ad.id || "";
    if (staleAdId) {
      const elapsedMs = Math.min(Date.now() - cache.shown_at_ms, MAX_DISPLAY_MS);
      await logImpression(
        staleAdId,
        wallet,
        cache.ad.impression_token || "",
        server,
        elapsedMs,
        cache.event_uuid ?? randomUUID(),
      );
    }
  }

  const ad = await requestAd({
    wallet,
    context: contextFromSession(session),
    agent: AGENT_CLAUDE_CODE,
    surface: "status_line",
    server,
  });
  if (!ad) return "";

  const line = formatStatusline(ad);
  if (!line) return "";
  // Reserve → render → cache un-billed. Billing happens on a later poll
  // (above), once we know how long this ad was actually on screen. Mint the
  // idempotency key now, at first display, so whichever later poll ends up
  // billing this occurrence reuses the same event_uuid.
  saveCache({
    ad,
    fetched_at: now,
    shown_at_ms: Date.now(),
    session_id: sessionId,
    billed: false,
    event_uuid: randomUUID(),
  });
  return line;
}

export async function readSessionFromStdin(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
