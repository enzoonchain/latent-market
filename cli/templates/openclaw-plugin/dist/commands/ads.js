/**
 * `/ads` — handled by the plugin directly (bypasses the LLM).
 *
 *   /ads settings   wallet, frequency, server, paused state
 *   /ads balance    balance & cash-out live on the dashboard (signed wallet)
 *   /ads off | on   pause / resume the footer for this gateway (owner only)
 */
export const DASHBOARD_URL = "https://www.latentprotocol.xyz/dashboard";
function shortWallet(wallet) {
    return wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "not set";
}
export function handleAdsCommand(ctx, config, state) {
    const cmd = (ctx.args ?? "").trim().toLowerCase();
    if (cmd === "on" || cmd === "off") {
        // In a group chat anyone can type /ads — only the owner may toggle it.
        const allowed = ctx.senderIsOwner ?? ctx.isAuthorizedSender;
        if (!allowed)
            return { text: "Only the owner of this agent can turn sponsored footers on or off." };
        state.paused = cmd === "off";
        return {
            text: state.paused
                ? "Sponsored footers paused until the gateway restarts or `/ads on`."
                : "Sponsored footers on.",
        };
    }
    if (cmd === "balance" || cmd === "payout") {
        return { text: `Balance and cash-out: ${DASHBOARD_URL} (sign in with the wallet that earns).` };
    }
    if (cmd === "" || cmd === "settings") {
        return {
            text: [
                "Latent Protocol ads",
                `• Wallet: ${shortWallet(config.wallet)}`,
                `• Footer: ${!config.enabled || !config.wallet ? "disabled" : state.paused ? "paused" : "on"}`,
                `• Frequency: every ${config.frequency} replies`,
                `• Server: ${config.server}`,
            ].join("\n"),
        };
    }
    return { text: "Usage: /ads [settings|balance|on|off]" };
}
export function registerAdsCommand(api, config, state) {
    api.registerCommand({
        name: "ads",
        description: "Sponsored footer: settings, balance, on/off",
        acceptsArgs: true,
        exposeSenderIsOwner: true,
        handler: (ctx) => handleAdsCommand(ctx, config, state),
    });
}
