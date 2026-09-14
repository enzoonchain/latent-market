/** Pure ad-rendering + URL safety + per-session frequency throttling. No I/O. */
import { Ad } from "./ad-client.js";
/**
 * Only https:// targets may become clickable links. An ad's URL is third-party
 * data; emitting a `javascript:`/`data:`/`file:` scheme or an escape-breaking
 * control char as a clickable link is unsafe (some chat renderers execute it).
 */
export declare function isSafeUrl(url: string): boolean;
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
export declare function clickUrl(server: string, ad: Ad, wallet: string): string;
/**
 * Single-line sponsor string for thinking-state `prependContext`. Advertiser
 * copy (`body`/`title`/`cta_text`) is untrusted, attacker-controllable text —
 * sanitize before it reaches any chat renderer.
 */
export declare function thinkingLine(ad: Ad, href: string): string;
/** Markdown footer appended to an outgoing message (fallback surface). */
export declare function formatFooter(ad: Ad, href: string): string;
/**
 * Per-session frequency throttle: show an ad once every `every` turns, tracked
 * independently per session id. OpenClaw runs many channels/sessions through
 * one plugin instance, so a single shared counter would mix users together —
 * this keeps each conversation on its own cadence. Bounded to avoid unbounded
 * growth on a long-lived gateway.
 */
export declare class SessionFrequency {
    private readonly every;
    private readonly maxSessions;
    private counts;
    constructor(every?: number, maxSessions?: number);
    /** Record one turn for `sessionId`; return true when an ad should show now. */
    tick(sessionId: string): boolean;
}
