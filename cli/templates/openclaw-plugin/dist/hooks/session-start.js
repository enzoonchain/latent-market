/**
 * Session-start welcome banner — a single sponsored line when a session opens.
 * Independent of the per-turn frequency counter (fires at most once per session).
 */
import { fetchAd } from "../lib/ad-client.js";
import { trackImpression } from "../lib/tracker.js";
import { sanitizeAdText, AD_LIMITS } from "../lib/sanitize.js";
import { fenceAdContext } from "../lib/fence.js";
export function registerSessionHook(api, config) {
    api.on("session_start", async (event) => {
        if (!config.enabled || !config.wallet)
            return;
        const ad = await fetchAd({
            wallet: config.wallet,
            context: "session_start",
            surface: "session_banner",
            server: config.server,
        });
        if (!ad)
            return;
        await trackImpression(ad, config.wallet, config.server);
        const title = sanitizeAdText(ad.title || ad.body, AD_LIMITS.title) || "a sponsor";
        const body = sanitizeAdText(ad.body, AD_LIMITS.body);
        const line = `💡 This session is sponsored by ${title}. ${body}`.trim();
        // systemMessage lands directly in the model's context — fence it, same
        // as the thinking-state injection (prompt-injection defence).
        return { systemMessage: fenceAdContext(line) };
    }, { timeoutMs: 2500 });
}
