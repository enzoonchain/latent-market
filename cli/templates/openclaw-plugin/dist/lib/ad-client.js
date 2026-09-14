/**
 * HTTP client for the Latent Protocol ad marketplace.
 *
 * Mirrors the Python `AdClient` / `Tracker`. Every call is fail-open with a
 * hard 2s timeout — the agent must never stall or break because of ads.
 */
import { deviceId } from "./config.js";
const TIMEOUT_MS = 2000;
async function postJson(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        return await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    }
    catch {
        return null; // fail open — agent works without ads
    }
    finally {
        clearTimeout(timer);
    }
}
/** Request the best matching ad. Returns `null` if none / on any error. */
export async function fetchAd(req) {
    const resp = await postJson(`${req.server}/ad/request`, {
        user_wallet: req.wallet,
        agent: "openclaw",
        context: req.context.slice(0, 100) || "general",
        surface: req.surface,
        device_id: deviceId(),
    });
    if (!resp || !resp.ok)
        return null;
    try {
        return (await resp.json());
    }
    catch {
        return null;
    }
}
/** The marketplace returns either `ad_id` or `id`; normalise to one string. */
export function adId(ad) {
    return ad.ad_id ?? ad.id ?? "";
}
