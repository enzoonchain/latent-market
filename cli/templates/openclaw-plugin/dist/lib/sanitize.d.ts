/**
 * Ad copy is advertiser-controlled and lands in a chat message (the response
 * footer) across whatever channel OpenClaw is
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
/**
 * Clean advertiser text for a display sink. `max` clamps the visible length
 * (an ellipsis is appended when clipped). Returns "" for nullish input.
 */
export declare function sanitizeAdText(input: string | null | undefined, max?: number): string;
/** Per-field caps matching protocol/openapi.yaml. */
export declare const AD_LIMITS: {
    readonly title: 30;
    readonly body: 140;
    readonly cta_text: 24;
};
