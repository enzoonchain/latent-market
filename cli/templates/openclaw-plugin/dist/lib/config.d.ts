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
/** Server-issued credential shared with the other Latent surfaces. Empty if unset. */
export declare function deviceId(): string;
export declare function ensureDeviceCredential(server: string): Promise<string>;
/** Merge the SDK-provided config with env fallbacks and defaults. */
export declare function getConfig(raw?: Partial<PluginConfig>): PluginConfig;
