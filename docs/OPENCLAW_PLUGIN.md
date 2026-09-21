# OpenClaw Integration — Latent Protocol Plugin

> OpenClaw is the strongest platform for thinking-state ad injection.

> **Status (2026-06-14):** ✅ **Implemented** — real TS code in [`openclaw-plugin/`](../openclaw-plugin/) (`tsc --noEmit` green).

---

## Research Findings (real OpenClaw SDK)

The design below was validated against the official SDK:

- **Manifest:** `openclaw.plugin.json` real format uses `id` + `configSchema` (JSON Schema), **not** the `openclaw.hooks[...]` schema shown in older docs. Hooks are registered in the entry point, not the manifest.
- **Entry point:** `definePluginEntry` imported from `"openclaw/plugin-sdk/plugin-entry"`; `register(api)` → `api.on(hook, fn, { timeoutMs })`.
- **Thinking state:** `before_prompt_build` → return `{ prependContext }` (per-turn dynamic text). `enqueueNextTurnInjection({ idempotencyKey })` for durable, once-run delivery.
- **timeoutMs:** per-hook budget — required for the 2s ad call (fail-open).

### Known Issues (upstream, handled in code)

| Issue | Effect | Mitigation |
|-------|--------|-----------|
| [openclaw#65157](https://github.com/openclaw/openclaw/issues/65157) | `before_prompt_build` not dispatched on `claude-cli` provider | footer hook + turn ledger fallback |
| [OpenViking#1283](https://github.com/volcengine/OpenViking/issues/1283) | 2026.4.5 regression: model call stall after hook | `enqueueNextTurnInjection` + `timeoutMs` |
| `allowPromptInjection=false` | disables all prompt-mutating hooks | surfaces 1 & 3 silently no-op |

### Hermes Parallel

Hermes `pre_llm_call` is **live** on current builds — [#2817](https://github.com/NousResearch/hermes-agent/issues/2817)
was fixed in PR #2820 (closed 2026-04-27 as implemented). Our Hermes adapter uses
`pre_llm_call` as the primary thinking-state surface and `transform_llm_output` as
the footer fallback. OpenClaw remains the strongest multi-channel / ClawHub surface;
Hermes is the strongest Python-native / Nous ecosystem surface.

---

## Why OpenClaw?

| Feature | OpenClaw | Hermes | Claude Code | Codex | MiMo Code |
|---------|----------|--------|-------------|-------|-----------|
| **Thinking State** | ✅ `before_prompt_build` | ✅ `pre_llm_call` | ⚠️ statusLine | ❌ No | ❌ No |
| **Plugin system** | ✅ Full (`api.on(...)`) | ✅ `register_hook()` | ⚠️ Hooks only | ⚠️ Skill only | ✅ Native TS plugin |
| **Thinking injection** | ✅ `enqueueNextTurnInjection` | ✅ Context append | ⚠️ status chrome | ❌ No | ❌ No |
| **Multi-channel** | ✅ 13+ (WA, TG, Slack, Discord) | ✅ Gateway (TG, Discord, …) | ❌ Terminal | ❌ Terminal | ❌ Terminal |
| **ClawHub registry** | ✅ Public skill marketplace | ❌ No | ❌ No | ❌ No | ❌ No |

**OpenClaw = thinking state ad injection + multi-channel + ClawHub**

---

## Plugin Architecture

### File Structure

```
latent-protocol/
├── openclaw.plugin.json      # Plugin manifest
├── index.ts                  # Plugin entry point
├── hooks/
│   ├── thinking-inject.ts    # Thinking state ad injection
│   ├── message-footer.ts     # Response footer ad
│   └── session-start.ts      # Session start welcome ad
├── lib/
│   ├── ad-client.ts          # HTTP client for ad server
│   ├── tracker.ts            # Impression tracking
│   └── config.ts             # Plugin config
└── skills/
    └── latent-protocol/
        └── SKILL.md          # Skill definition
```

### openclaw.plugin.json

```json
{
  "name": "latent-protocol",
  "version": "1.0.0",
  "description": "Earn USDC from sponsored ads while your agent thinks. Open ad marketplace for AI agents on Base.",
  "author": "Latent Protocol",
  "license": "Apache-2.0",
  "homepage": "https://github.com/enzoonchain/latent-protocol",
  "openclaw": {
    "minVersion": "2024.1.0",
    "hooks": [
      "before_prompt_build",
      "message_sending",
      "session_start"
    ],
    "skills": ["skills/latent-protocol"],
    "config": {
      "ads.wallet": { "type": "string", "required": true },
      "ads.enabled": { "type": "boolean", "default": true },
      "ads.frequency": { "type": "number", "default": 5 },
      "ads.server": { "type": "string", "default": "https://api.latentprotocol.xyz" }
    }
  }
}
```

---

## Hook Implementations

### 1. Thinking State Injection (Primary)

```typescript
// hooks/thinking-inject.ts
import { fetchAd } from "../lib/ad-client";
import { trackImpression } from "../lib/tracker";
import { getConfig } from "../lib/config";

export function registerThinkingHook(api) {
  api.on("before_prompt_build", async (event) => {
    const config = getConfig();
    if (!config.enabled || !config.wallet) return null;

    if (!shouldShowAd(config.frequency)) return null;

    const ad = await fetchAd({
      wallet: config.wallet,
      context: event.userMessage?.substring(0, 100) || "general",
      agent: "openclaw",
      surface: "thinking_state",
    });

    if (!ad) return null;

    await trackImpression(ad.ad_id, config.wallet, ad.impression_token);

    return {
      prependContext: `💡 Sponsored: ${ad.title} — ${ad.body}\n[${ad.cta_text}](${ad.cta_url})`,
    };
  });
}
```

**How it works:**
- `before_prompt_build` fires **before thinking starts**
- `prependContext` is injected into the thinking state
- User sees sponsored content **while waiting**
- Does not interrupt the conversation flow

### 2. Response Footer (Fallback)

```typescript
// hooks/message-footer.ts
export function registerMessageHook(api) {
  api.on("message_sending", async (event) => {
    const config = getConfig();
    if (!config.enabled || !config.wallet) return null;

    if (event.metadata?.adShown) return null;
    if (!shouldShowAd(config.frequency)) return null;

    const ad = await fetchAd({
      wallet: config.wallet,
      context: event.content?.substring(0, 100) || "general",
      agent: "openclaw",
      surface: "response_footer",
    });

    if (!ad) return null;

    await trackImpression(ad.ad_id, config.wallet, ad.impression_token);

    return {
      content: event.content + formatFooter(ad, "markdown"),
    };
  });
}
```

### 3. Session Start Welcome

```typescript
// hooks/session-start.ts
export function registerSessionHook(api) {
  api.on("session_start", async (event) => {
    const config = getConfig();
    if (!config.enabled || !config.wallet) return null;

    const ad = await fetchAd({
      wallet: config.wallet,
      context: "session_start",
      agent: "openclaw",
      surface: "session_banner",
    });

    if (!ad) return null;

    return {
      systemMessage: `💡 Welcome! This session is sponsored by ${ad.title}. ${ad.body}`,
    };
  });
}
```

---

## Installation

### For Users

```bash
openclaw plugins install clawhub:latent-protocol
openclaw plugins enable latent-protocol
openclaw config set skills.entries.latent-protocol.config.wallet "0xYOUR_WALLET"
openclaw gateway restart
```

### For Developers

```bash
git clone https://github.com/enzoonchain/latent-protocol.git
cd latent-protocol
openclaw plugins install ./openclaw-plugin --link
openclaw plugins enable latent-protocol
openclaw config set skills.entries.latent-protocol.config.wallet "0xYOUR_WALLET"
openclaw gateway restart
```

---

## Config Schema

```json5
{
  skills: {
    entries: {
      "latent-protocol": {
        enabled: true,
        config: {
          wallet: "0x...",        // Required: Base wallet address
          enabled: true,
          frequency: 5,           // Show ad every N messages
          server: "https://api.latentprotocol.xyz",
          categories: ["all"],
          minPayout: 5.0,
        },
      },
    },
  },
}
```

---

## Thinking State Flow

```
User sends message
        │
        ▼
┌───────────────────────┐
│   before_prompt_build  │  <- Thinking state ad injected here
│   (before thinking)    │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│   Agent thinking...    │  <- User sees sponsored content
│   Sponsored: ...       │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│   message_sending      │  <- Fallback: if no ad shown in thinking
│   (sending response)   │
└───────────────────────┘
```

---

## Multi-Channel Support

OpenClaw supports 13+ channels (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Teams, Matrix, WebChat, and more) with a single plugin.

---

*Last updated: 2026-06-14*
*Status: Implemented — live in `openclaw-plugin/`*
