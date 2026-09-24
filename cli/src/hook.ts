/**
 * Turn-hook runtime — the logic the installed lifecycle hooks invoke.
 *
 *   latent hook <event> --agent claude-code [< payload.json]
 *
 * Events: session-start, turn-start, turn-end, session-end.
 * Flow: at turn-start we classify locally, fetch one ad by category slug, and
 * hand it to the Claude Code status line's cache; the status line renders and
 * bills it. The raw prompt never leaves the machine — only the category slug
 * is sent.
 *
 * The hook never writes anything the model reads (no `additionalContext`):
 * ads are for the user's screen only. Any other `--agent` value — e.g. a
 * Codex hooks.json left behind by an older release — is a silent no-op.
 */
import { cacheFile, configDir, isEnabled, loadConfig, resolveServer, resolveWallet } from "./config.js";
import { requestAd, type Ad } from "./api.js";
import { classifyPrompt } from "./classify.js";
import { loadState, saveState, type HookState } from "./adcache.js";
import { refreshKillswitch } from "./killswitch.js";
import { spinnerVerb, writeSpinnerVerb } from "./surfaces/claude-spinner.js";
import { mkdirSync, writeFileSync } from "node:fs";

export type HookEvent = "session-start" | "turn-start" | "turn-end" | "session-end";
export type HookAgent = "claude-code";

/** Pull the user's prompt text out of whatever payload shape the host sends. */
function extractPrompt(payload: Record<string, unknown>): string {
  for (const key of ["prompt", "user_message", "message", "input", "text", "context"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  // Codex/Claude sometimes nest the latest user turn under a transcript array.
  const t = payload.transcript ?? payload.messages;
  if (Array.isArray(t)) {
    for (let i = t.length - 1; i >= 0; i--) {
      const m = t[i] as { role?: string; content?: unknown };
      if (m && m.role === "user" && typeof m.content === "string") return m.content;
    }
  }
  return "";
}

function extractSessionId(payload: Record<string, unknown>): string {
  for (const key of ["session_id", "sessionId", "conversation_id", "id"]) {
    const v = payload[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * Mirror the statusLine cache so the Claude Code status line shows this ad.
 *
 * `billed: false` is the important part: we hand the status line an ad nobody
 * has charged for yet, and it bills on first render. Prefetching here is what
 * lets the status line show an ad targeted at the actual prompt instead of a
 * generic "coding" context.
 */
function writeStatuslineCache(ad: Ad, sessionId: string): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      cacheFile(),
      JSON.stringify({
        ad,
        fetched_at: Date.now() / 1000,
        session_id: sessionId,
        billed: false,
      }),
    );
  } catch {
    // best-effort
  }
}

/**
 * Reset the dwell counters. The hook never bills: the status line renders the
 * ad and owns its impression (statusline.ts). Billing here too would charge a
 * single displayed ad twice, or charge for one that never reached the screen.
 */
function resetDwell(state: HookState): void {
  state.displayedMs = 0;
  state.displayStartedAt = 0;
}

/**
 * Run a hook event. Returns the string to print on stdout (host-specific hook
 * output), or "" when nothing should be emitted. Never throws.
 */
export async function runHook(
  event: HookEvent,
  agent: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  if (agent !== "claude-code") return "";
  const cfg = loadConfig();
  if (!isEnabled(cfg)) return "";
  const wallet = resolveWallet(cfg);
  if (!wallet) return "";
  const server = resolveServer(cfg);

  const state = loadState();
  const payloadSession = extractSessionId(payload);

  try {
    switch (event) {
      case "session-start": {
        saveState({
          sessionId: payloadSession || state.sessionId || String(Date.now()),
          category: "",
          ad: null,
          fetchedAt: 0,
          displayStartedAt: 0,
          displayedMs: 0,
        });
        // Refresh the remote killswitch here (session startup, not a turn) and
        // at turn-end below — never at turn-start, where latency is visible.
        await refreshKillswitch(server);
        return "";
      }

      case "turn-start": {
        resetDwell(state);

        const prompt = extractPrompt(payload);
        const category = classifyPrompt(prompt);
        const ad = await requestAd({
          wallet,
          context: category, // slug only — no raw prompt leaves the machine
          agent,
          surface: "status_line",
          server,
          sessionId: payloadSession || state.sessionId,
        });
        if (!ad) {
          saveState(state);
          return "";
        }
        const next: HookState = {
          sessionId: payloadSession || state.sessionId,
          category,
          ad,
          fetchedAt: Date.now(),
          displayStartedAt: Date.now(),
          displayedMs: 0,
        };
        saveState(next);
        writeStatuslineCache(ad, next.sessionId);

        // Claude Code shows the ad via its statusLine (kept out of the model
        // context). Second surface: keep settings.json `spinnerVerbs` in sync
        // with the live ad so the thinking-shimmer verb shows it next session.
        // Only when `init` positively confirmed CLI support; the write is a
        // comment-safe minimal edit and never touches a user-set value.
        if (cfg.spinner_verbs === true) {
          writeSpinnerVerb(spinnerVerb(ad.body || ad.title || "Sponsored"));
        }
        return "";
      }

      case "turn-end": {
        resetDwell(state);
        saveState(state);
        // Post-turn (not user-visible latency) — keep the killswitch fresh for
        // long sessions that never restart.
        void refreshKillswitch(server);
        return "";
      }

      case "session-end": {
        resetDwell(state);
        saveState({
          sessionId: state.sessionId,
          category: "",
          ad: null,
          fetchedAt: 0,
          displayStartedAt: 0,
          displayedMs: 0,
        });
        return "";
      }
    }
  } catch {
    // fail open — never break the host agent's turn
    return "";
  }
  return "";
}
