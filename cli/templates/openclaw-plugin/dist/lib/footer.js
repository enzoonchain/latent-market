/** Pure ad-rendering + URL safety + per-session frequency throttling. No I/O. */
import { adId } from "./ad-client.js";
import { sanitizeAdText, AD_LIMITS } from "./sanitize.js";
/**
 * Only https:// targets may become clickable links. An ad's URL is third-party
 * data; emitting a `javascript:`/`data:`/`file:` scheme or an escape-breaking
 * control char as a clickable link is unsafe (some chat renderers execute it).
 */
export function isSafeUrl(url) {
    if (typeof url !== "string" || !url.startsWith("https://"))
        return false;
    // Reject control chars (incl. ESC 0x1b / BEL 0x07, all < 0x20) and DEL 0x7f.
    return [...url].every((c) => {
        const code = c.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f;
    });
}
/**
 * Build the click-tracking redirect for an ad. The displayed CTA points here;
 * the server logs the click and 302s to the advertiser. Makes clicks
 * attributable in every channel where the link is clickable (clicks earn 50x).
 *
 * `t` is the signed click token from /ad/request — without it the server
 * won't credit the click (S6 hardening: otherwise anyone who knows an ad_id +
 * wallet, both public via /ad/leaderboard and /earnings, could forge a click
 * for a wallet that never clicked anything).
 */
export function clickUrl(server, ad, wallet) {
    const id = encodeURIComponent(adId(ad));
    const w = encodeURIComponent(wallet);
    const t = encodeURIComponent(ad.click_token ?? "");
    return `${server}/ad/click?ad=${id}&w=${w}&t=${t}`;
}
/**
 * Single-line sponsor string for thinking-state `prependContext`. Advertiser
 * copy (`body`/`title`/`cta_text`) is untrusted, attacker-controllable text —
 * sanitize before it reaches any chat renderer.
 */
export function thinkingLine(ad, href) {
    const body = sanitizeAdText(ad.body || ad.title, AD_LIMITS.body) || "Sponsored";
    const cta = sanitizeAdText(ad.cta_text, AD_LIMITS.cta_text) || "Learn more";
    // Only surface the URL if it's a safe https target.
    const tail = isSafeUrl(href) ? ` — ${cta}: ${href}` : ` — ${cta}`;
    return `💡 Sponsored while you wait: ${body}${tail}`;
}
/** Markdown footer appended to an outgoing message (fallback surface). */
export function formatFooter(ad, href) {
    const body = sanitizeAdText(ad.body || ad.title, AD_LIMITS.body) || "Sponsored";
    const cta = sanitizeAdText(ad.cta_text, AD_LIMITS.cta_text) || "Learn more";
    const earn = ad.earn_amount ?? 0;
    // Render a clickable markdown link only for safe https; else plain text.
    const ctaLine = isSafeUrl(href) ? `[${cta} →](${href})` : `${cta} →`;
    return (`\n\n---\n` +
        `💰 **Sponsored:** ${body}  \n` +
        `${ctaLine}  \n` +
        `_+$${earn} USDC earned_`);
}
/**
 * Per-session frequency throttle: show an ad once every `every` turns, tracked
 * independently per session id. OpenClaw runs many channels/sessions through
 * one plugin instance, so a single shared counter would mix users together —
 * this keeps each conversation on its own cadence. Bounded to avoid unbounded
 * growth on a long-lived gateway.
 */
export class SessionFrequency {
    every;
    maxSessions;
    counts = new Map();
    constructor(every = 5, maxSessions = 2000) {
        this.every = every;
        this.maxSessions = maxSessions;
        this.every = Math.max(Math.trunc(every) || 1, 1);
    }
    /** Record one turn for `sessionId`; return true when an ad should show now. */
    tick(sessionId) {
        const next = (this.counts.get(sessionId) ?? 0) + 1;
        if (!this.counts.has(sessionId) && this.counts.size >= this.maxSessions) {
            const oldest = this.counts.keys().next().value; // Map keeps insertion order
            if (oldest !== undefined)
                this.counts.delete(oldest);
        }
        this.counts.set(sessionId, next);
        return next % this.every === 0;
    }
}
