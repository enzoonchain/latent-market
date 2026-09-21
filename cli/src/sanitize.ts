/**
 * Ad copy is advertiser-controlled and is rendered into a terminal status line,
 * the Claude Code thinking-shimmer, and (for Codex) the model's own context.
 * None of those are safe sinks for raw bytes:
 *
 *   - a terminal acts on ESC / CSI / OSC sequences (move the cursor, clear the
 *     screen, set the window title, on some terminals worse),
 *   - bidi-override codepoints can visually reorder text to disguise a link,
 *   - the server's `title ≤ 30` / `body ≤ 140` limits are not enforced here.
 *
 * `sanitizeAdText` removes escape sequences, hard-strips every control
 * character (so even a partial or novel sequence can't reach the terminal),
 * neutralises bidi overrides, collapses whitespace, and clamps length. It is
 * deliberately lossy — anything ambiguous is dropped, not escaped.
 */

/* eslint-disable no-control-regex */

/**
 * Cosmetic first pass — drop whole recognised escape sequences so the result
 * doesn't contain visible junk like "[2J". Security does NOT depend on this
 * being exhaustive; the control-character strip below is the real backstop.
 *   OSC   ESC ] … (BEL | ST)
 *   CSI   ESC [ params intermediates final
 *   nF    ESC intermediates final
 *   Fe    ESC single-char
 */
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
