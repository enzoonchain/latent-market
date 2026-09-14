/**
 * Fence untrusted advertiser copy before it enters model-visible context.
 *
 * `prependContext` (thinking-inject.ts) and `systemMessage` (session-start.ts)
 * land directly in front of the model, unlike the chat-visible footer/thinking
 * lines — exactly the sink a prompt-injection attack targets. The line must
 * already be sanitized (`sanitizeAdText`); this wraps it so the model can tell
 * it is sponsor copy, not an instruction, and strips characters that could
 * break out of the fence. Mirrors `cli/src/hook.ts`'s `fencedAdContext` (kept
 * as a separate copy — no cross-package import, see `tsconfig.json` `rootDir`).
 */
export declare function fenceAdContext(line: string): string;
