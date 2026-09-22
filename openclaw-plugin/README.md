# Latent Protocol — OpenClaw Plugin

Earn USDC from one labelled **sponsored footer under the agent's final reply**,
across every OpenClaw channel (WhatsApp, Telegram, Slack, Discord, …) from a
single plugin. Ads are for the people reading the reply — never context for the
model.

## Ad Surface

| Surface | Hook | Notes |
|---------|------|-------|
| Response footer | `reply_payload_sending` (`kind === "final"` only) | Appended in the outbound delivery layer, after the agent run — it reaches the channel, not the model's transcript. Plain text on WhatsApp/Signal/SMS/iMessage, markdown elsewhere. |
| Billing | `message_sent` | The impression is reported only when a delivery for the same conversation succeeds and its text still contains the footer. |
| `/ads` command | `api.registerCommand` | `settings`, `balance` (→ dashboard), `on`/`off` (owner only). |

Frequency is counted **per conversation** (`sessionKey`), so every chat keeps
its own cadence. Only a locally computed category slug is sent to the ad
server — never message text.

Deliberately **not** used: `before_prompt_build` (`prependContext` is model
context; the user never sees it) and `session_start` (observe-only; return
values are discarded).

**Click attribution:** the CTA points at the server's `/ad/click` redirect with
the signed click token, which logs the click and 302s to the advertiser. Only
safe `https://` targets are ever rendered as links.

## Install

```bash
# From ClawHub (once published)
openclaw plugins install clawhub:latent-protocol
openclaw plugins enable latent-protocol
openclaw config set plugins.entries.latent-protocol.config.wallet "0xYOUR_WALLET"
openclaw gateway restart

# Local dev
openclaw plugins install ./openclaw-plugin --link
```

## Config

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `wallet` | ✅ | — | Base (EVM) address that receives USDC |
| `enabled` | | `true` | Master on/off switch |
| `frequency` | | `1` | Footer once every N final replies, per conversation |
| `server` | | `https://api.latentprotocol.xyz` | Ad server URL |
| `minPayout` | | `5.0` | Deprecated, ignored (payouts are on the dashboard) |

Env fallbacks (`ADS_WALLET`, `ADS_ENABLED`, `ADS_FREQUENCY`, `ADS_SERVER`,
`ADS_MIN_PAYOUT`) are honoured for local dev / CI.

## Build

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # → dist/
```

> The `openclaw` package is a **peer dependency**. Ambient types in
> `src/types/openclaw.d.ts` keep `typecheck` working before it's installed; the
> real SDK overrides them at build/runtime.

## Known Caveats (upstream)

| Issue | Effect | Our mitigation |
|-------|--------|----------------|
| [openclaw#65157](https://github.com/openclaw/openclaw/issues/65157) | `before_prompt_build` not dispatched on the `claude-cli` provider | Footer hook (surface 2) takes over via the turn ledger |
| [OpenViking#1283](https://github.com/volcengine/OpenViking/issues/1283) | 2026.4.5 regression: model call could stall after the hook | `timeoutMs` budget on every hook; fail-open |
| `allowPromptInjection=false` | Disables all prompt-mutating hooks | Surface 1 & 3 silently no-op; nothing breaks |

## Fail-open Guarantee

Every network call has a hard 2s timeout and fails open — if the ad server is
slow or unreachable, the agent runs exactly as if the plugin weren't installed.
