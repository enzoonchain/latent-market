/**
 * HTTP client for the Latent Protocol ad marketplace.
 *
 * Mirrors the Python `AdClient` / `Tracker`. Every call is fail-open with a
 * hard 2s timeout — the agent must never stall or break because of ads.
 */
export interface Ad {
    ad_id?: string;
    id?: string;
    title?: string;
    body?: string;
    cta_text?: string;
    cta_url?: string;
    earn_amount?: number;
    impression_token?: string;
    click_token?: string;
}
export interface AdRequest {
    wallet: string;
    context: string;
    surface: string;
    server: string;
}
/** Request the best matching ad. Returns `null` if none / on any error. */
export declare function fetchAd(req: AdRequest): Promise<Ad | null>;
/** The marketplace returns either `ad_id` or `id`; normalise to one string. */
export declare function adId(ad: Ad): string;
