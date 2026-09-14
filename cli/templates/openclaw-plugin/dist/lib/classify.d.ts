/**
 * Local message categorizer.
 *
 * Mirrors the CodeBacks / cli `classify.ts` privacy model: categorization runs
 * entirely on the machine hosting the plugin, over the user's message text,
 * and ONLY the resulting category slug ever leaves the machine (as the
 * ad-request targeting tag). The raw message must never be forwarded as-is —
 * `thinking-inject.ts` and `message-footer.ts` used to send `event.userMessage`
 * / `event.content` verbatim as `context`; this is what replaces that.
 *
 * Kept as a separate copy of `cli/src/classify.ts` (no manifest-file scan,
 * since a gateway plugin has no single project `cwd`) — this package has no
 * dependency on `cli/`, see `tsconfig.json` `rootDir`. Keep the category slugs
 * identical across both so server-side targeting sees one consistent set.
 */
export type Category = "frontend-ui" | "backend" | "databases" | "devops-infra" | "ai-ml" | "web3-crypto" | "mobile" | "data-eng" | "general";
/**
 * Classify a chat message into a coarse category slug. Only this slug should
 * ever be sent to the ad server — never `message` itself.
 */
export declare function classifyMessage(message: string | null | undefined): Category;
