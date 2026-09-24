---
name: latent-protocol
description: "Monetize AI agent idle time with sponsored ads. Earn USDC on Base while your agent thinks. Use when: setting up ad monetization for an AI agent, installing latent-protocol, configuring earning wallets, integrating sponsored content into Hermes/Telegram/Claude Code/CLI agents, checking ad earnings balance, or requesting USDC payouts."
---

# Latent Protocol

Earn USDC on Base while your agent thinks. Sponsored ads appear during idle time — you get paid, user sees relevant content. Setup takes 2 minutes.

## Step 1 — Detect platform

Run:
```bash
python -c "from latent_protocol.adapters.unified import detect_platform; print(detect_platform())" 2>/dev/null || echo "not_installed"
```

If output is `not_installed`, install first:
```bash
pip install "latent-protocol[mcp]"
```
Then re-run the detection command.

If detection returns `mcp`, check for existing MCP config:
```bash
cat ~/.claude/mcp.json 2>/dev/null || cat claude_desktop_config.json 2>/dev/null || echo "no_mcp_config"
```
If `no_mcp_config` and no Claude Code present, fall back to `cli` mode by running:
```bash
export LATENT_PLATFORM=cli
```

## Step 2 — Install

Based on detected platform:

| Platform | Command |
|----------|---------|
| hermes, telegram, cli | `pip install latent-protocol` |
| mcp | `pip install "latent-protocol[mcp]"` |
| openclaw | `openclaw plugins install clawhub:latent-protocol` |
| claude-code | `pip install latent-protocol && latent-statusline --install` |

## Step 3 — Wire integration

### hermes

Find the Hermes plugin directory and the file with `def register(ctx):`:
```bash
grep -rl "def register" --include="*.py" ~/.hermes/plugins/ 2>/dev/null || grep -rl "def register" --include="*.py" . 2>/dev/null
```
Insert at the top of the `register()` function body:
```python
from latent_protocol.adapters.unified import UnifiedAdapter
UnifiedAdapter().register(ctx)
```

### telegram

In the message handler, wrap the outgoing text:
```python
from latent_protocol.adapters.unified import UnifiedAdapter
_ad = UnifiedAdapter()

response = your_llm(message.text)
await message.reply_text(
    _ad.wrap_response(response, context=message.text, user_id=str(update.effective_user.id)),
    parse_mode="Markdown",
)
```

### claude-code / mcp

Add to MCP config (`~/.claude/mcp.json` or `claude_desktop_config.json`):
```json
{"mcpServers":{"latent-protocol":{"command":"latent-mcp"}}}
```

### cli

```python
from latent_protocol.adapters.unified import UnifiedAdapter
_ad = UnifiedAdapter()

@_ad.inject
def ask(prompt: str) -> str:
    return call_llm(prompt)
```

### universal (any platform)

```python
from latent_protocol.adapters.unified import UnifiedAdapter
_ad = UnifiedAdapter()
output = _ad.wrap(llm_response, context="general")
```

## Step 4 — Setup wallet

Check if wallet already exists:
```bash
cat ~/.latent-protocol/config.json 2>/dev/null || echo "no_wallet"
```

If output contains `wallet`, skip to Step 5 — wallet is already configured.

If `no_wallet`, run:
```bash
latent-setup
```

**Important:** If a new wallet is generated, the private key is shown ONCE. The user must save it immediately and import into MetaMask or any EVM wallet to access USDC earnings.

## Step 5 — Verify

Run:
```bash
latent-adapter
```

Check the JSON output for:
- `wallet` must NOT be `"not set"` → if missing, run `latent-setup` again
- `enabled` must be `true` → if false, set `ADS_ENABLED=true`
- `server` must be `https://api.latentprotocol.xyz` → if wrong, set `ADS_SERVER=https://api.latentprotocol.xyz`

Then verify API connectivity:
```bash
curl -s https://api.latentprotocol.xyz/health
```

Expected: `{"status":"ok",...}`

If the API is unreachable, check internet connection and try again.

**If all checks pass**, report:
> Latent Protocol active. Earning USDC from ads on Base.

**If any check fails**, report the specific failure:
- `wallet = "not set"` → "Run `latent-setup` to configure your earning wallet"
- `enabled = false` → "Set `ADS_ENABLED=true` in your environment"
- API unreachable → "Check your internet connection. The API server may be temporarily down."

## What's next

After setup, ads appear automatically:
- **Hermes**: sponsored line in the Hermes Desktop status bar (no chat footer)
- **Telegram**: Wrap each bot reply with `adapter.wrap_response()`
- **CLI**: Use `@adapter.inject` decorator or `adapter.wrap()`
- **MCP**: Call `check_balance()` to see earnings, `request_payout()` to withdraw

Check earnings anytime:
```bash
latent-adapter   # shows wallet, balance, server status
```

## Revenue

Every impression earns **50% of CPM** (~$0.0025). Clicks earn 50x. Payouts in USDC on Base. Minimum $5. No signup — just a wallet.

## Config

| Variable | Default | Purpose |
|----------|---------|---------|
| `ADS_WALLET` | — | EVM address for earnings |
| `ADS_ENABLED` | `true` | Master on/off |
| `ADS_FREQUENCY` | `5` | Show ad every N responses |
| `ADS_SERVER` | `https://api.latentprotocol.xyz` | Ad server URL |
| `ADS_MIN_PAYOUT` | `5.0` | USDC minimum payout |
| `LATENT_PLATFORM` | auto | Override: hermes/telegram/cli/mcp |
