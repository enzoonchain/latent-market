# Latent Protocol — Plugin Installation Guide

Earn USDC from sponsored ads shown in your AI agent. Pick your platform below.

---

## One-line install (recommended)

```bash
npx github:enzoonchain/latent-protocol init
```

`latent-protocol` is not on the npm registry yet, so `npx latent-protocol`
resolves to an unrelated package — use the GitHub form above until it is
published, then this shortens to `npx latent-protocol init`.

Detects Claude Code / Grok Build / Hermes / Hermes WebUI / OpenClaw, sets up a wallet, and
patches every surface it finds (CLI plugin, WebUI DOM patch, statusLine, OpenClaw plugin).
See the [dev plan](DEV_PLAN_NPX_HERMES.md) for architecture details.

---

## Requirements

- **Claude Code path:** Node.js 18+
- **Hermes / MCP / Telegram / CLI path:** Python 3.10+
- An EVM wallet address on Base (generated during setup, or bring your own)

---

## Option A — MCP Server (Universal)

Works with **Claude, OpenClaw, Cursor, Windsurf**, and any MCP-capable agent.

### 1. Install

```bash
pip install 'latent-protocol[mcp]'
```

### 2. Set up your wallet

```bash
latent-setup
```

Generates a new wallet or imports your existing address. Config saved to `~/.latent-protocol/config.json`. You only need to do this once.

### 3. Add to your MCP config

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "latent-protocol": {
      "command": "latent-mcp"
    }
  }
}
```

**OpenClaw** (`~/.openclaw/mcp.json`):

```json
{
  "mcpServers": {
    "latent-protocol": {
      "command": "latent-mcp"
    }
  }
}
```

### 4. Available MCP tools

| Tool | Description |
|------|-------------|
| `setup_wallet(mode, address)` | Generate or import your earning wallet |
| `request_ad(context, surface)` | Fetch a sponsored recommendation |
| `check_balance()` | Your current USDC earnings balance |
| `request_payout()` | Withdraw earned USDC (min $5) |
| `ad_status()` | Show current config and status |

---

## Option B — Hermes Plugin

Hermes discovers plugins from a **flat** directory (`plugin.yaml` + `__init__.py`
with `register(ctx)`) or via the `hermes_agent.plugins` pip entry point.
Plugins are **opt-in** — you must enable them.

### Recommended: `npx github:enzoonchain/latent-protocol init`

```bash
npx github:enzoonchain/latent-protocol init
# or non-interactive:
npx github:enzoonchain/latent-protocol init --yes --generate
```

(Shortens to `npx latent-protocol init` once the npm publish lands.)

This installs the Python package, writes `~/.hermes/plugins/agent-ads/`, enables
the plugin, and saves your wallet to `~/.latent-protocol/config.json`.

### Manual install

```bash
pip install latent-protocol
# until PyPI publish lands, use:
# pip install 'git+https://github.com/enzoonchain/latent-protocol.git'

latent-setup   # writes ~/.latent-protocol/config.json

# Flat plugin dir (required for directory discovery):
mkdir -p ~/.hermes/plugins/agent-ads
# copy plugin/plugin.yaml + plugin/__init__.py into that directory
# (npx github:enzoonchain/latent-protocol init does this for you)

hermes plugins enable agent-ads
hermes gateway restart   # if you use the messaging gateway
```

**Do not** clone the whole monorepo into `~/.hermes/plugins/` — Hermes will not
find `plugin.yaml` one level deeper.

### Config note

The adapter reads **`~/.latent-protocol/config.json`** (and `ADS_*` env vars),
not Hermes `ads.wallet` keys. Prefer `latent-setup` or `/ads setup` in chat.

### Use /ads commands in chat

```
/ads setup          — configure your wallet
/ads setup generate — generate a new wallet
/ads setup use 0x.. — use your existing address
/ads balance        — check USDC earnings
/ads payout         — withdraw to your wallet
/ads on / off       — toggle ads
/ads settings       — view current config
```

### Surfaces

| Surface | Hook | Status |
|---------|------|--------|
| Thinking-state reserve | `pre_llm_call` (reserve only — **not billable**) | ✅ Live (Hermes ≥ fix #2820) |
| Response footer | `transform_llm_output` + confirm on `post_llm_call` / `post_response` | ✅ Live (bill only if shown) |
| Hermes gateway (Telegram, Discord, …) | Same `agent-ads` plugin | ✅ Same install as CLI |
| Hermes Desktop response footer | Same `agent-ads` plugin (Desktop's `hermes serve` backend shares `HERMES_HOME` with the CLI) | ✅ Automatic — no separate install |
| Hermes Desktop status bar | Desktop Plugin SDK (`desktop/plugin.js` in the same `agent-ads` folder) | ✅ via `npx init` when a wallet is configured |
| WebUI banner + footer | DOM patch via `latent-hermes-patch` (WebUI does **not** load Hermes plugins) | ✅ via `npx init` when `static/` is found |
| OpenClaw (WA/TG/Slack/…) | TS plugin thinking + footer | ✅ via `npx init` when `~/.openclaw` / `openclaw` found |
| Claude Code | statusLine | ✅ via `npx init` |
| Grok Build | `[ui.status_line]` command in `~/.grok/config.toml` | ✅ via `npx init` (restart Grok) |

### Hermes Desktop

[Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
is not a separate product — it's a native Electron/React shell around the
**same** Hermes agent, running a headless `hermes serve` backend against the
**same** `HERMES_HOME` (`~/.hermes`) and plugin directory as the CLI. That
means:

- The sponsored-footer text and the `/ads` chat command already work in
  Desktop chat with **zero extra setup** — they're the same
  `pre_llm_call` / `transform_llm_output` / `post_llm_call` / `post_response`
  hooks and command registered by the `agent-ads` plugin for the CLI.
- `npx latent-protocol init` additionally writes a native
  [Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)
  plugin to `~/.hermes/plugins/agent-ads/desktop/plugin.js` (the "one
  package, both SDKs" pattern — same folder as the CLI plugin). It adds a
  status-bar chip showing your live USDC balance; clicking it opens a small
  panel with the wallet address and a **Request payout** button. The chip
  only appears once a wallet is configured (`/ads setup` or `latent-setup`) —
  re-run `npx github:enzoonchain/latent-protocol init` after changing wallets, since the value is baked
  into the file at install time.
- Toggling ads on/off, frequency, and other settings stay on the `/ads
  settings` chat command — same as CLI/TUI.

---

## Option C — Claude Code (status line)

```bash
npx github:enzoonchain/latent-protocol init
# or:
npx github:enzoonchain/latent-protocol statusline --install
```

Writes a `statusLine` block into `~/.claude/settings.json` that runs
`npx --yes latent statusline` on every refresh. Restart Claude Code to apply.

---

## Option D — Telegram Bot

Works with **python-telegram-bot**, **aiogram**, **telebot**, and any Python bot framework.

### 1. Install

```bash
pip install latent-protocol
```

### 2. Set up your wallet

```bash
latent-setup
```

### 3. Wrap your response handler

```python
from latent_protocol.adapters.telegram import TelegramAdAdapter

adapter = TelegramAdAdapter()

async def handle_message(update, context):
    response = await your_llm(update.message.text)
    await update.message.reply_text(
        adapter.wrap_response(response, context=update.message.text),
        parse_mode="Markdown",
    )
```

**Per-user frequency tracking:**

```python
adapter = TelegramAdAdapter(per_user=True)

# In your handler:
adapter.wrap_response(response, context=text, user_id=str(update.effective_user.id))
```

---

## Option E — CLI / Terminal

Works with **Click**, **Typer**, **argparse**, and plain Python scripts.

### 1. Install

```bash
pip install latent-protocol
```

### 2. Set up your wallet

```bash
latent-setup
```

### 3a. Decorator (zero boilerplate)

```python
from latent_protocol.adapters.cli import CliAdAdapter

adapter = CliAdAdapter()

@adapter.inject
def ask(prompt: str) -> str:
    return your_llm(prompt)

# calling ask("hello") automatically appends an ANSI ad banner
```

### 3b. Manual

```python
response = your_llm(prompt)
adapter.print_response(response, context=prompt)
```

---

## Configuration

Config is read in priority order: **config file > env vars > defaults**.

| Setting | Config file key | Env var | Default |
|---------|----------------|---------|---------|
| Wallet address | `wallet` | `ADS_WALLET` | — |
| Enabled | `enabled` | `ADS_ENABLED` | `true` |
| Ad frequency | `frequency` | `ADS_FREQUENCY` | `1` (every message) |
| Server URL | `server` | `ADS_SERVER` | `https://api.latentprotocol.xyz` |
| Min payout | `min_payout` | `ADS_MIN_PAYOUT` | `5.0` USDC |

Config file location: `~/.latent-protocol/config.json`

---

## Earnings & Payouts

- **50%** of every impression goes to you
- **50%** of every click goes to you (clicks worth 50× impressions by default)
- Minimum payout threshold: **$5 USDC**
- Payouts settle on **Base** (L2, near-zero gas)
- Check balance: `check_balance()` (MCP) or `/ads balance` (Hermes)
- Request payout: `request_payout()` (MCP) or `/ads payout` (Hermes)
