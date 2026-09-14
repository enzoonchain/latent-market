/**
 * Response-footer ad — fallback surface.
 *
 * Only serves when the thinking-state hook did NOT run for this turn (e.g. the
 * claude-cli provider that doesn't dispatch before_prompt_build). On providers
 * where thinking-state works, `ledger.claim()` returns false here and the
 * footer stays silent so we never double-serve.
 *
 * NOTE: `message_sending` is the assumed outgoing-message hook name; confirm
 * against your OpenClaw build's hook list before relying on the footer path.
 */
import { fetchAd } from "../lib/ad-client.js";
import { trackImpression } from "../lib/tracker.js";
import { formatFooter, clickUrl } from "../lib/footer.js";
import { classifyMessage } from "../lib/classify.js";
const HOOK_TIMEOUT_MS = 2500;
export function registerFooterHook(api, config, freq, ledger) {
    api.on("message_sending", async (event) => {
        if (!config.enabled || !config.wallet)
            return;
        if (!ledger.claim(event.sessionId))
            return; // thinking hook owns this turn
        if (!freq.tick(event.sessionId))
            return;
        // Classify locally — only the category slug leaves the machine, never
        // the raw outgoing message text.
        const ad = await fetchAd({
            wallet: config.wallet,
            context: classifyMessage(event.content),
            surface: "response_footer",
            server: config.server,
        });
        if (!ad)
            return;
        await trackImpression(ad, config.wallet, config.server);
        const href = clickUrl(config.server, ad, config.wallet);
        return { content: event.content + formatFooter(ad, href) };
    }, { timeoutMs: HOOK_TIMEOUT_MS });
}
