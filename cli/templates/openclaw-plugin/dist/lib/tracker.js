/**
 * Impression + click tracking. Best-effort, fail-open — the server is the
 * authority on what is billable, so a dropped report just means no earnings.
 */
import { adId } from "./ad-client.js";
const TIMEOUT_MS = 2000;
async function post(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    }
    catch {
        // best effort
    }
    finally {
        clearTimeout(timer);
    }
}
/** Report a confirmed display. `impression_token` from /ad/request is required. */
export async function trackImpression(ad, wallet, server) {
    await post(`${server}/ad/impression`, {
        ad_id: adId(ad),
        user_wallet: wallet,
        token: ad.impression_token ?? "",
    });
}
export async function trackClick(ad, wallet, server) {
    await post(`${server}/ad/click`, {
        ad_id: adId(ad),
        user_wallet: wallet,
        token: ad.click_token ?? "",
    });
}
