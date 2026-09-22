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
| `setup_wallet(mode, email, address)` | Bind an email-claimable Privy wallet or import your address |
| `request_ad(context, surface)` | Fetch a sponsored recommendation |
| `check_balance()` | Your current USDC earnings balance |
| `request_payout()` | Withdraw earned USDC (min $5) |
| `ad_status()` | Show current config and status |

---

## Option B — Hermes Plugin

Hermes discovers plugins from a **flat** directory (`plugin.yaml` + `__init__.py`
with `register(ctx)`) or via the `hermes_agent.plugins` pip entry point.
Plugins are **opt-in** — you must enable them.

### Recommended: `npx latent-protocol init`

```bash
npx latent-protocol init
# or non-interactive:
npx latent-protocol init --wallet 0x…
```

This writes a **standalone** plugin to `~/.hermes/plugins/agent-ads/`
(`plugin.yaml`, a stdlib-only `__init__.py`, `desktop/plugin.js`), enables it,
and saves your wallet to `~/.latent-protocol/config.json`. No pip package is
needed: Hermes runs from its own venv (often uv-built, with no pip), so a
plugin that imports a pip package would fail there with
`No module named 'latent_protocol'`.

### Manual install

```bash
mkdir -p ~/.hermes/plugins/agent-ads
# copy cli/templates/hermes-plugin/{plugin.yaml,__init__.py} into that directory
hermes plugins enable agent-ads
hermes gateway restart   # if you use the messaging gateway
```

**Do not** clone the whole monorepo into `~/.hermes/plugins/` — Hermes will not
find `plugin.yaml` one level deeper.

### Config note

The plugin reads **`~/.latent-protocol/config.json`** (and `ADS_*` env vars),
not Hermes `ads.wallet` keys.

### Use /ads commands in chat

```
/ads setup                  — wallet options
/ads setup email you@domain — get a wallet you claim with your email
/ads setup use 0x..         — use your existing address
/ads balance                — balance & cash-out (opens on the dashboard; payouts need a wallet signature)
/ads on / off               — resume / pause the footer for this session
/ads settings               — view current config
```

### Surfaces

| Surface | How | Status |
|---------|-----|--------|
| Response footer (CLI, TUI, Desktop chat) | `transform_llm_output` — a labelled "Sponsored" footer; Hermes applies it before the reply is stored and delivered, so the billed impression is the one shown | ✅ |
| Hermes gateway (Telegram, Discord, …) | Same footer, platform-formatted | ✅ Same install as CLI |
| Hermes Desktop status bar | Desktop Plugin SDK (`desktop/plugin.js`): one sponsored line, popover with CTA + dashboard link; impression once per creative, only while the window is visible | ✅ via `npx init` when a wallet is configured |
| WebUI banner + footer | DOM patch (WebUI does **not** load Hermes plugins) | ✅ via `npx init` when `static/` is found |

`pre_llm_call` is deliberately **not** used: its return value is appended to the
user's message and reaches only the model, never the user.

Footer links go through `GET /ad/click?ad=…&w=…&t=<click_token>`: the server
credits the click and 302s to the advertiser's stored URL.

### Hermes Desktop

[Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
runs a headless `hermes serve` backend against the **same** `HERMES_HOME`
(`~/.hermes`) and plugin directory as the CLI, so the footer and `/ads` work in
Desktop chat with no extra setup. The `desktop/plugin.js` in the same folder
adds the status-bar line. Wallet and device id are baked in at install time —
re-run `npx latent-protocol init` after changing wallets.

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
