# Latent Protocol — Client SDK & Platform Adapters

> Earn USDC on Base while your AI agent thinks.

While your agent is working, a single sponsored line appears in space that was
otherwise idle — a status line, a spinner, a message footer. You earn 50% of
the ad revenue in USDC on [Base](https://base.org), paid via
[x402](https://x402.org).

This repository is the **client half** of Latent Protocol: the adapters that
render that line inside each agent, the CLI that installs them, and the SDK
they share. The ad server is a separate service — everything here talks to it
over one documented HTTP contract ([`protocol/openapi.yaml`](protocol/openapi.yaml)),
and you never need a real one to develop or test.

**Adapters are where contributions matter most.** Every agent surfaces idle
time differently, and nobody can cover them all. If your agent isn't
supported, adding it is a self-contained piece of work — see
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## Install

Public beta (`0.1.4-beta.5` on the `beta` dist-tag; `latest` currently points at the same version). Ads run against the Base Sepolia ad server — not a mainnet launch.

```bash
npx latent-protocol@beta init
```

`npx latent-protocol init` also works while `latest` tracks this beta. Detects the agents you have installed, sets up a wallet, and patches every surface it finds. Reverse it any time:

```bash
npx latent-protocol@beta status      # wallet, balance, patched surfaces
npx latent-protocol@beta uninstall   # revert every patch
```

GitHub fallback (no registry): `npx github:enzoonchain/latent-market init`.

## Supported surfaces

| Agent | How the ad is delivered | Where |
|-------|------------------------|-------|
| **Claude Code** | `statusLine` + turn hooks (local `node` bundles, no `npx` at runtime); `spinnerVerbs` thinking-shimmer line on CC ≥ 2.1.143 | [`cli/src/surfaces/claude-code.ts`](cli/src/surfaces/claude-code.ts) |
| **Grok Build** | `[ui.status_line]` command in `~/.grok/config.toml` (same staged `statusline.mjs`; restart Grok to apply) | [`cli/src/surfaces/grok.ts`](cli/src/surfaces/grok.ts) |
| **Codex** | turn hooks in `hooks.json` (local `node` bundle, no `npx` at runtime) | [`cli/src/surfaces/codex.ts`](cli/src/surfaces/codex.ts) |
| **MiMo Code** | native plugin in `~/.config/mimocode/plugins/`, sponsored response footer | [`cli/src/surfaces/mimo.ts`](cli/src/surfaces/mimo.ts) |
| **OpenClaw** | plugin — thinking state + footer | [`openclaw-plugin/`](openclaw-plugin/) |
| **Hermes** (CLI, gateway, WebUI) | pip plugin + WebUI DOM patch | [`cli/src/surfaces/hermes.ts`](cli/src/surfaces/hermes.ts) |
| **Cursor / VS Code** | extension: status bar, opt-in spinner patch | [`vscode-extension/`](vscode-extension/) |
| **Telegram** | response wrapper | [`latent_protocol/adapters/telegram.py`](latent_protocol/adapters/telegram.py) |
| **CLI apps** | `@inject` decorator | [`latent_protocol/adapters/cli.py`](latent_protocol/adapters/cli.py) |
| **Any MCP host** | MCP tool server | [`latent_protocol/mcp_server.py`](latent_protocol/mcp_server.py) |

## Develop against the mock server

No credentials, no ad server, no network:

```bash
node tools/mock-ad-server.mjs
export ADS_SERVER=http://127.0.0.1:8899
```

The mock implements the contract and deliberately exercises the paths adapters
get wrong — 204 no-fill, invalid tokens, replayed impressions, injected
failures and latency:

```bash
node tools/mock-ad-server.mjs --no-fill=3 --latency=500 --fail=0.2
```

Its request log tells you whether your adapter is behaving. If one displayed
ad produces more than one `impression billed` line, you are double-counting.

## Layout

```
cli/                 npx installer, surface patchers, turn-hook runtime (TypeScript)
latent_protocol/     Python SDK — ad client, tracker, footer rendering, adapters
  adapters/          hermes, hermes_webui, telegram, cli, claude_code, unified
openclaw-plugin/     OpenClaw plugin (thinking-state + footer hooks)
vscode-extension/    Cursor / VS Code extension
plugin/              Hermes plugin manifest
protocol/            openapi.yaml — the client ↔ ad-server contract
tools/               mock-ad-server.mjs — local ad server for development
docs/                install guide, advertiser guide, placement strategy
```

## Tests

```bash
pip install -e ".[dev]" && pytest -q     # Python SDK + adapters
npm ci --prefix cli && npm run build --prefix cli
node --test cli/tests/*.test.mjs         # CLI + surface patchers
```

## Configuration

Client config lives in `~/.latent-protocol/config.json`, written by
`npx latent-protocol init`. Environment variables override it — see
[`.env.example`](.env.example).

## License

[Apache-2.0](LICENSE)
