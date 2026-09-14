/**
 * Plugin configuration.
 *
 * OpenClaw validates the user's config against `openclaw.plugin.json`'s
 * `configSchema` and hands the resulting object to the plugin. We merge it with
 * `process.env` fallbacks, `~/.latent-protocol/config.json` (written by
 * `npx latent-protocol init`), and defaults so a single `getConfig(raw)` call
 * is the only config source the hooks ever touch.
 */
export interface PluginConfig {
    wallet: string;
    enabled: boolean;
    frequency: number;
    server: string;
    minPayout: number;
}
/**
 * Stable per-install identifier, shared with every other surface (Claude
 * Code, Codex/MiMo, the VS Code extension, and the Python adapters all
 * read/write this same file). Not a secret — a correlation signal so the
 * server can cap per physical machine, not only per (free, instantly-
 * mintable) wallet. Best-effort: never throws.
 */
export declare function deviceId(): string;
/** Merge the SDK-provided config with env fallbacks and defaults. */
export declare function getConfig(raw?: Partial<PluginConfig>): PluginConfig;
