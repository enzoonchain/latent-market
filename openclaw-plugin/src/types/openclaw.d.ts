/**
 * Minimal ambient declarations for the slice of the OpenClaw plugin SDK this
 * plugin uses, copied from openclaw/openclaw `src/plugins/*.types.ts`
 * (hook-types.ts, hook-message.types.ts, plugin-api.types.ts,
 * plugin-command.types.ts). The real `openclaw` peer dependency provides the
 * full types at runtime; this keeps `tsc --noEmit` honest without it.
 *
 * Only names the real `openclaw/plugin-sdk/plugin-entry` exports are exported
 * here (checked against openclaw@2026.9.5). Hook event/context types are not
 * public there, so plugin code gets them by inference from `api.on(...)`.
 *
 * Refs:
 *   https://docs.openclaw.ai/plugins/sdk-entrypoints
 *   https://docs.openclaw.ai/plugins/hooks
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface HookOptions {
    priority?: number;
    timeoutMs?: number;
  }

  /** Shared context of outbound message hooks (`PluginHookMessageContext`). */
  interface MessageHookContext {
    channelId: string;
    accountId?: string;
    conversationId?: string;
    /** Canonical session key — the same value `message_sent` fires with. */
    sessionKey?: string;
  }

  /** Outbound reply payload (subset of `ReplyPayload`). */
  interface ReplyPayload {
    text?: string;
    [key: string]: unknown;
  }

  /** `reply_payload_sending` — modify/gate one outbound reply. */
  interface ReplyPayloadSendingEvent {
    payload: ReplyPayload;
    /** "final" is the finished answer; "tool"/"block" are progress payloads. */
    kind: "tool" | "block" | "final";
    channel?: string;
    sessionKey?: string;
    runId?: string;
  }

  interface ReplyPayloadSendingResult {
    payload?: ReplyPayload;
    cancel?: boolean;
    reason?: string;
  }

  /** `message_sent` — observe a delivery attempt (fire-and-forget). */
  interface MessageSentEvent {
    to: string;
    content: string;
    success: boolean;
    messageId?: string;
    sessionKey?: string;
    runId?: string;
    error?: string;
  }

  type HookMap = {
    reply_payload_sending: [
      ReplyPayloadSendingEvent,
      MessageHookContext,
      ReplyPayloadSendingResult | void,
    ];
    message_sent: [MessageSentEvent, MessageHookContext, void];
  };

  export interface PluginCommandContext {
    senderId?: string;
    channel: string;
    isAuthorizedSender: boolean;
    /** Present only when the command sets `exposeSenderIsOwner`. */
    senderIsOwner?: boolean;
    sessionKey?: string;
    args?: string;
    commandBody: string;
  }

  export interface PluginCommandResult {
    text?: string;
  }

  export interface OpenClawPluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    exposeSenderIsOwner?: boolean;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
  }

  export interface OpenClawPluginApi {
    /** The whole OpenClaw config — NOT this plugin's settings. */
    config: Record<string, unknown>;
    /** This plugin's settings (`plugins.entries.<id>.config`), schema-validated. */
    pluginConfig?: Record<string, unknown>;
    on<K extends keyof HookMap>(
      hook: K,
      handler: (
        event: HookMap[K][0],
        ctx: HookMap[K][1],
      ) => Promise<HookMap[K][2]> | HookMap[K][2],
      options?: HookOptions,
    ): void;
    registerCommand(def: OpenClawPluginCommandDefinition): void;
    logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  }

  export interface PluginEntry {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void | Promise<void>;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
