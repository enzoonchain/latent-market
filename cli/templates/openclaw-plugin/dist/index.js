/**
 * Latent Protocol — OpenClaw plugin entry point.
 *
 * Earn USDC from one labelled sponsored footer under the agent's final reply,
 * on every channel OpenClaw bridges. Ads are shown to people, never fed to the
 * model: see hooks/reply-footer.ts for the surface and billing rules.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getConfig } from "./lib/config.js";
import { registerReplyFooter } from "./hooks/reply-footer.js";
import { registerAdsCommand } from "./commands/ads.js";
export default definePluginEntry({
    id: "latent-protocol",
    name: "Latent Protocol",
    description: "Earn USDC from a labelled sponsored footer under the agent's final reply. " +
        "Open ad marketplace for AI agents on Base.",
    register(api) {
        // `api.config` is the whole OpenClaw config; ours is `api.pluginConfig`.
        const config = getConfig((api.pluginConfig ?? {}));
        const state = { paused: false };
        if (!config.wallet) {
            api.logger?.warn("[latent-protocol] no wallet configured — ads disabled. " +
                "Run `npx latent-protocol init` or set plugins.entries.latent-protocol.config.wallet.");
        }
        registerReplyFooter(api, config, state);
        registerAdsCommand(api, config, state);
    },
});
