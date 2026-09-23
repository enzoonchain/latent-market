import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PendingImpressions, registerReplyFooter, type AdsState, type ConversationContext } from "../src/hooks/reply-footer.js";
import { handleAdsCommand, DASHBOARD_URL } from "../src/commands/ads.js";
import type { PluginConfig } from "../src/lib/config.js";

const WALLET = "0x" + "ab".repeat(20);
const SERVER = "https://srv.example";
const AD = {
  ad_id: "ad-1",
  body: "Move assets to Base",
  cta_text: "Bridge now",
  cta_url: "https://example.com/bridge",
  earn_amount: 0.0025,
  impression_token: "imp-tok",
  click_token: "clk-tok",
};
const CTX: ConversationContext = { channelId: "telegram", conversationId: "c1" };

function config(over: Partial<PluginConfig> = {}): PluginConfig {
  return { wallet: WALLET, enabled: true, frequency: 1, server: SERVER, minPayout: 5, ...over };
}

function fakeApi() {
  const hooks: Record<string, (event: any, ctx: any) => any> = {};
  const api = {
    config: {},
    on: (name: string, fn: any) => {
      hooks[name] = fn;
    },
    registerCommand: () => {},
  };
  return { api: api as any, hooks };
}

let calls: { url: string; body: any }[] = [];
let adResponse: any = AD;

beforeEach(() => {
  calls = [];
  adResponse = AD;
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/ad/request")) {
      return adResponse
        ? { ok: true, status: 200, json: async () => adResponse }
        : { ok: false, status: 204, json: async () => null };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
});
afterEach(() => vi.unstubAllGlobals());

const final = (text: string, extra: any = {}) => ({ payload: { text }, kind: "final", sessionKey: "s1", ...extra });

describe("reply_payload_sending footer", () => {
  it("registers only the delivery hooks — nothing that reaches the model", () => {
    const { api, hooks } = fakeApi();
    registerReplyFooter(api, config(), { paused: false });
    expect(Object.keys(hooks).sort()).toEqual(["message_sent", "reply_payload_sending"]);
  });

  it("appends a footer to the final reply and bills only after a successful send", async () => {
    const { api, hooks } = fakeApi();
    registerReplyFooter(api, config(), { paused: false });
    const res = await hooks.reply_payload_sending(final("Here is the answer about solidity"), CTX);
    const text = res.payload.text as string;
    expect(text.startsWith("Here is the answer about solidity\n\n> Move assets to Base")).toBe(true);
    expect(text).toMatch(/ · _Sponsored: \+\$[^ ]+ USDC_$/);
    expect(text).toContain(`${SERVER}/ad/click?ad=ad-1&w=${WALLET}&t=clk-tok`);
    expect(calls.map((c) => c.url)).toEqual([`${SERVER}/ad/request`]); // not billed yet

    const req = calls[0]!.body;
    expect(req.surface).toBe("response_footer");
    expect(req.context).not.toContain("solidity answer"); // a slug, never the text
    expect(req.context.length).toBeLessThan(20);

    await hooks.message_sent({ to: "x", content: "unrelated", success: true, sessionKey: "s1" }, CTX);
    expect(calls.length).toBe(1); // footer not in this send
    await hooks.message_sent({ to: "x", content: text, success: false, sessionKey: "s1" }, CTX);
    expect(calls.length).toBe(1); // failed delivery is not billed
    await hooks.message_sent({ to: "x", content: text, success: true, sessionKey: "s1" }, CTX);
    expect(calls.map((c) => c.url)).toEqual([`${SERVER}/ad/request`, `${SERVER}/ad/impression`]);
    expect(calls[1]!.body).toEqual({ ad_id: "ad-1", user_wallet: WALLET, token: "imp-tok" });

    await hooks.message_sent({ to: "x", content: text, success: true, sessionKey: "s1" }, CTX);
    expect(calls.length).toBe(2); // billed once
  });

  it("bills the chunk that carries the footer when a long reply is split", async () => {
    const { api, hooks } = fakeApi();
    registerReplyFooter(api, config(), { paused: false });
    const res = await hooks.reply_payload_sending(final("x".repeat(50)), CTX);
    const footer = (res.payload.text as string).slice(50);
    await hooks.message_sent({ to: "x", content: "x".repeat(50), success: true, sessionKey: "s1" }, CTX);
    await hooks.message_sent({ to: "x", content: footer, success: true, sessionKey: "s1" }, CTX);
    expect(calls.filter((c) => c.url.endsWith("/ad/impression")).length).toBe(1);
  });

  it("leaves tool/block payloads, media-only payloads and paused state alone", async () => {
    const { api, hooks } = fakeApi();
    const state: AdsState = { paused: false };
    registerReplyFooter(api, config(), state);
    expect(await hooks.reply_payload_sending(final("progress", { kind: "block" }), CTX)).toBeUndefined();
    expect(await hooks.reply_payload_sending(final("tool", { kind: "tool" }), CTX)).toBeUndefined();
    expect(await hooks.reply_payload_sending({ payload: { mediaUrl: "https://m" }, kind: "final" }, CTX)).toBeUndefined();
    state.paused = true;
    expect(await hooks.reply_payload_sending(final("answer"), CTX)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("no wallet / disabled / no fill: reply untouched, nothing billed", async () => {
    for (const cfg of [config({ wallet: "" }), config({ enabled: false })]) {
      const { api, hooks } = fakeApi();
      registerReplyFooter(api, cfg, { paused: false });
      expect(await hooks.reply_payload_sending(final("answer"), CTX)).toBeUndefined();
    }
    expect(calls).toEqual([]);
    adResponse = null;
    const { api, hooks } = fakeApi();
    registerReplyFooter(api, config(), { paused: false });
    expect(await hooks.reply_payload_sending(final("answer"), CTX)).toBeUndefined();
    expect(calls.filter((c) => c.url.endsWith("/ad/impression"))).toEqual([]);
  });

  it("frequency is per conversation", async () => {
    const { api, hooks } = fakeApi();
    registerReplyFooter(api, config({ frequency: 2 }), { paused: false });
    expect(await hooks.reply_payload_sending(final("a", { sessionKey: "A" }), CTX)).toBeUndefined();
    expect(await hooks.reply_payload_sending(final("b", { sessionKey: "B" }), CTX)).toBeUndefined();
    expect((await hooks.reply_payload_sending(final("c", { sessionKey: "A" }), CTX)).payload.text).toContain("Sponsored");
  });

  it("uses a plain-text footer on WhatsApp", async () => {
    const { api, hooks } = fakeApi();
    registerReplyFooter(api, config(), { paused: false });
    const res = await hooks.reply_payload_sending(final("hi", { channel: "whatsapp" }), { channelId: "whatsapp" });
    expect(res.payload.text).toContain("Move assets to Base");
    expect(res.payload.text).toMatch(/ · Sponsored: \+\$[^ ]+ USDC$/);
    expect(res.payload.text).not.toContain("**");
  });
});

describe("PendingImpressions", () => {
  it("expires entries after 10 minutes", () => {
    let t = 0;
    const p = new PendingImpressions(() => t);
    p.add("k", AD, "\n\nfooter");
    t = 11 * 60 * 1000;
    expect(p.take("k", "…footer")).toBeNull();
  });
});

describe("/ads command", () => {
  const base = { channel: "telegram", commandBody: "/ads", isAuthorizedSender: true };

  it("settings, balance → dashboard, usage", () => {
    const state = { paused: false };
    expect(handleAdsCommand({ ...base, args: "" }, config(), state).text).toContain("0xabab…abab");
    expect(handleAdsCommand({ ...base, args: "balance" }, config(), state).text).toContain(DASHBOARD_URL);
    expect(handleAdsCommand({ ...base, args: "nope" }, config(), state).text).toContain("Usage");
  });

  it("only the owner can toggle", () => {
    const state = { paused: false };
    const notOwner = handleAdsCommand({ ...base, args: "off", senderIsOwner: false }, config(), state);
    expect(notOwner.text).toContain("Only the owner");
    expect(state.paused).toBe(false);
    handleAdsCommand({ ...base, args: "off", senderIsOwner: true }, config(), state);
    expect(state.paused).toBe(true);
    handleAdsCommand({ ...base, args: "on", senderIsOwner: true }, config(), state);
    expect(state.paused).toBe(false);
  });
});
