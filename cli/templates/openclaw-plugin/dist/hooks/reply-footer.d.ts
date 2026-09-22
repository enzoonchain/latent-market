/**
 * Response footer — the one ad surface.
 *
 * `reply_payload_sending` runs in the outbound delivery layer for every reply
 * payload, after the agent run: whatever it returns is what the channel
 * (WhatsApp, Telegram, Slack, …) delivers, and it never enters the model's
 * transcript. Only `kind === "final"` — the finished answer — gets a footer;
 * tool/block progress payloads are left alone.
 *
 * Billing is deferred to `message_sent`: the impression is reported only when
 * a delivery for the same session succeeds and its text still contains our
 * footer (another plugin can rewrite or cancel the payload after us, and
 * delivery can fail). `message_sent` is fire-and-forget, so this never delays
 * delivery.
 *
 * Deliberately NOT used: `before_prompt_build` (`prependContext` is model
 * context — the user never sees it) and `session_start` (observe-only; a
 * returned value is discarded).
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginConfig } from "../lib/config.js";
import { type Ad } from "../lib/ad-client.js";
import { SessionFrequency } from "../lib/footer.js";
export interface AdsState {
    /** `/ads off` pauses serving for this gateway process. */
    paused: boolean;
}
/** Footers handed to delivery, waiting for a successful `message_sent`. */
export declare class PendingImpressions {
    private readonly now;
    private byKey;
    constructor(now?: () => number);
    add(key: string, ad: Ad, footer: string): void;
    /** The pending ad for `key` if `content` carries its footer; consumes it. */
    take(key: string, content: string): Ad | null;
    get size(): number;
    private prune;
}
/** The slice of the outbound message-hook context used to key a conversation. */
export interface ConversationContext {
    channelId: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
}
/** One conversation → one key; `sessionKey` is what `message_sent` echoes. */
export declare function conversationKey(sessionKey: string | undefined, ctx: ConversationContext): string;
export declare function registerReplyFooter(api: OpenClawPluginApi, config: PluginConfig, state: AdsState, deps?: {
    freq?: SessionFrequency;
    pending?: PendingImpressions;
}): {
    freq: SessionFrequency;
    pending: PendingImpressions;
};
