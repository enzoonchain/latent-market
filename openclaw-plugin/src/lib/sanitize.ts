/**
 * Ad copy is advertiser-controlled and lands in a chat message (thinking-state
 * line, session banner, response footer) across whatever channel OpenClaw is
 * bridging (Discord, Telegram, Slack, a terminal, …). None of those are safe
 * sinks for raw bytes:
 *
 *   - some renderers act on ESC / CSI / OSC sequences,
 *   - bidi-override codepoints can visually reorder text to disguise a link
 *     or hide characters, in any renderer, not just a terminal,
 *   - the server's `title ≤ 30` / `body ≤ 140` limits are not enforced here.
 *
 * Mirrors `cli/src/sanitize.ts` (kept as a separate copy — this package has no
 * dependency on `cli/`, see `tsconfig.json` `rootDir`). Keep the two in sync.
 */

/* eslint-disable no-control-regex */

const ESC_SEQ =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]|\x1b[@-_]/g;

/** Every C0 control (incl. ESC 0x1B), DEL, and every C1 control (incl. 8-bit CSI 0x9B). */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** Bidi overrides / isolates / deprecated formatting chars. */
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;

/**
 * Clean advertiser text for a display sink. `max` clamps the visible length
 * (an ellipsis is appended when clipped). Returns "" for nullish input.
 */
export function sanitizeAdText(input: string | null | undefined, max = 140): string {
  let s = String(input ?? "");
  s = s.replace(ESC_SEQ, "").replace(CONTROL, " ").replace(BIDI, "");
  s = s.replace(/\s+/g, " ").trim();
  if (max > 0 && s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  return s;
}

/** Per-field caps matching protocol/openapi.yaml. */
export const AD_LIMITS = { title: 30, body: 140, cta_text: 24 } as const;
