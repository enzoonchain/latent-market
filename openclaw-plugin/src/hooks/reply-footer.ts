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
import { adId, fetchAd, type Ad } from "../lib/ad-client.js";
import { trackImpression } from "../lib/tracker.js";
import { clickUrl, footerStyle, formatFooter, SessionFrequency } from "../lib/footer.js";
import { classifyMessage } from "../lib/classify.js";

const HOOK_TIMEOUT_MS = 2500; // a touch above the ad-client's 2s, then bail
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 1000;

export interface AdsState {
  /** `/ads off` pauses serving for this gateway process. */
  paused: boolean;
}

interface Pending {
  ad: Ad;
  footer: string;
  at: number;
}

/** Footers handed to delivery, waiting for a successful `message_sent`. */
export class PendingImpressions {
  private byKey = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  add(key: string, ad: Ad, footer: string): void {
    this.prune();
    if (this.byKey.size >= MAX_PENDING) {
      const oldest = this.byKey.keys().next().value;
      if (oldest !== undefined) this.byKey.delete(oldest);
    }
    this.byKey.set(key, { ad, footer, at: this.now() });
  }

  /** The pending ad for `key` if `content` carries its footer; consumes it. */
  take(key: string, content: string): Ad | null {
    const entry = this.byKey.get(key);
    if (!entry || this.now() - entry.at > PENDING_TTL_MS) return null;
    // Long replies can be split into several sends; the footer rides the last.
    if (!content.includes(entry.footer.trim())) return null;
    this.byKey.delete(key);
    return entry.ad;
  }

  get size(): number {
    return this.byKey.size;
  }

  private prune(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [key, entry] of this.byKey) {
      if (entry.at < cutoff) this.byKey.delete(key);
    }
  }
}

/** The slice of the outbound message-hook context used to key a conversation. */
export interface ConversationContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
}

/** One conversation → one key; `sessionKey` is what `message_sent` echoes. */
export function conversationKey(sessionKey: string | undefined, ctx: ConversationContext): string {
  return sessionKey || ctx.sessionKey || [ctx.channelId, ctx.accountId, ctx.conversationId].join(":");
}

export function registerReplyFooter(
  api: OpenClawPluginApi,
  config: PluginConfig,
  state: AdsState,
  deps: { freq?: SessionFrequency; pending?: PendingImpressions } = {},
): { freq: SessionFrequency; pending: PendingImpressions } {
  const freq = deps.freq ?? new SessionFrequency(config.frequency);
  const pending = deps.pending ?? new PendingImpressions();

  api.on(
    "reply_payload_sending",
    async (event, ctx) => {
      if (event.kind !== "final" || state.paused) return;
      if (!config.enabled || !config.wallet) return;
      const text = event.payload?.text;
      if (typeof text !== "string" || !text.trim()) return; // media-only / empty

      const key = conversationKey(event.sessionKey, ctx);
      if (!freq.tick(key)) return;

      // Classify locally — only the category slug leaves the machine.
      const ad = await fetchAd({
        wallet: config.wallet,
        context: classifyMessage(text),
        surface: "response_footer",
        server: config.server,
      });
      if (!ad || !adId(ad)) return;

      const footer = formatFooter(ad, clickUrl(config.server, ad, config.wallet), footerStyle(event.channel ?? ctx.channelId));
      pending.add(key, ad, footer);
      return { payload: { ...event.payload, text: text + footer } };
    },
    { timeoutMs: HOOK_TIMEOUT_MS },
  );

  api.on("message_sent", async (event, ctx) => {
    if (!event.success || typeof event.content !== "string") return;
    const ad = pending.take(conversationKey(event.sessionKey, ctx), event.content);
    if (ad) await trackImpression(ad, config.wallet, config.server);
  });

  return { freq, pending };
}
