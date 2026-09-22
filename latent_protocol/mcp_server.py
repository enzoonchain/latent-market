"""Universal MCP server — management + test tools for MCP-capable agents.

⚠️  TEST PHASE: request_ad and inject_footer are for testing only.
    Production ad delivery MUST use platform-specific adapters
    (Hermes plugin, Claude Code hooks, Telegram adapter, etc.).
    Reason: MCP tools are user-initiated — we lose control over ad timing.

Management tools (check_balance, request_payout, ad_status, setup_wallet)
are production-ready.

Run with: ``latent-mcp``.
"""

from mcp.server.fastmcp import FastMCP

from . import wallet as wallet_api
from .ad_client import AdClient
from .config import Config
from .tracker import Tracker

config = Config.from_env()
client = AdClient(config.server)
tracker = Tracker(config.server)

mcp = FastMCP("Latent Protocol")


@mcp.tool()
def request_ad(context: str = "general", surface: str = "tool_call") -> dict:
    """[TEST ONLY] Fetch a sponsored recommendation to optionally show the user.

    ⚠️  This tool is for testing/development only. Production ad delivery
    uses platform-specific adapters (Hermes plugin, Claude Code hooks, etc.)
    where WE control frequency, targeting, and timing.

    Args:
        context: What the user is working on (e.g. "defi", "coding").
        surface: Where it will be shown (tool_call, footer, cli).
    """
    if not config.enabled:
        return {"show": False, "reason": "disabled"}
    if not config.wallet:
        return {"show": False, "reason": "no_wallet"}

    from .delivery import reserve_ad

    ad = reserve_ad(
        client,
        wallet=config.wallet,
        context=context,
        agent="mcp",
        surface=surface,
    )
    if not ad:
        return {"show": False, "reason": "no_ads_available"}

    # Reserve only — call confirm_ad_shown after the host actually displays it.
    return {
        "show": True,
        "ad": ad,
        "billable": False,
        "note": "Not billed yet. Call confirm_ad_shown after displaying the ad.",
    }


@mcp.tool()
def confirm_ad_shown(ad_id: str, impression_token: str = "") -> dict:
    """Confirm that a reserved ad was actually shown to the user (billable).

    Call this only after the creative is visible in the UI / reply. Without
    this call, request_ad does not credit earnings.
    """
    if not config.wallet:
        return {"ok": False, "reason": "no_wallet"}
    if not ad_id:
        return {"ok": False, "reason": "missing_ad_id"}
    from .delivery import confirm_display

    confirm_display(
        tracker,
        {"ad_id": ad_id, "impression_token": impression_token},
        config.wallet,
    )
    return {"ok": True, "ad_id": ad_id}


@mcp.tool()
def check_balance() -> dict:
    """Check your current earnings balance in USDC on Base."""
    if not config.wallet:
        return {"error": "no_wallet"}
    return {
        "balance_usdc": wallet_api.get_balance(config.wallet, config.server),
        "wallet": config.wallet,
        "network": "Base",
    }


@mcp.tool()
def request_payout() -> dict:
    """Request a payout of earned USDC (minimum $5)."""
    if not config.wallet:
        return {"success": False, "reason": "no_wallet"}
    balance = wallet_api.get_balance(config.wallet, config.server)
    if balance < config.min_payout:
        return {
            "success": False,
            "reason": f"Minimum ${config.min_payout:.2f}. Current: ${balance:.4f}",
        }
    tx_hash = wallet_api.request_payout(config.wallet, config.server)
    return {"success": True, "tx_hash": tx_hash, "amount": balance}


@mcp.tool()
def ad_status() -> dict:
    """Show ad system status and current settings."""
    return {
        "enabled": config.enabled,
        "wallet": config.wallet or "not set",
        "frequency": config.frequency,
        "server": config.server,
        "min_payout": config.min_payout,
    }


@mcp.tool()
def setup_wallet(mode: str = "email", email: str = "", address: str = "") -> dict:
    """Set up your earning wallet. Call this once to start earning USDC.

    Args:
        mode: "email" to get a Privy wallet bound to an email (claim it later in
            the browser — no private key is ever created here), or "import" to
            use an existing EVM address.
        email: The email to bind the wallet to (mode="email").
        address: Your existing EVM address (mode="import").

    For Google / X / existing-wallet sign-in, run `npx latent-protocol init`.
    """
    from .setup import is_valid_address, save_config_file

    if mode == "email":
        if not email:
            return {"success": False, "error": "Provide the email to bind the wallet to in the 'email' field."}
        try:
            earner = wallet_api.pregenerate_email(email, config.server)
        except ValueError as exc:
            return {"success": False, "error": str(exc)}
        save_config_file(
            {"wallet": earner["wallet"], "privy_user_id": earner["privy_user_id"], "auth": "privy"}
        )
        config.wallet = earner["wallet"]
        return {
            "success": True,
            "address": earner["wallet"],
            "claim_url": earner["claim_url"],
            "next": (
                f"Ads earn USDC to this address now. Claim it with an email code at "
                f"{earner['claim_url']} to cash out."
            ),
        }

    if mode == "import":
        if not address:
            return {"success": False, "error": "Provide your wallet address in the 'address' field."}
        if not is_valid_address(address):
            return {"success": False, "error": "Invalid EVM address. Must be 0x + 40 hex chars."}
        save_config_file({"wallet": address, "auth": "address"})
        config.wallet = address
        return {
            "success": True,
            "address": address,
            "next": "Wallet saved. Ads will now earn USDC to this address.",
        }

    return {"success": False, "error": "mode must be 'email' or 'import'"}


@mcp.tool()
def inject_footer(text: str, style: str = "markdown", context: str = "general") -> dict:
    """[TEST ONLY] Append a sponsored footer to *text* and return the result.

    ⚠️  This tool is for testing/development only. Production ad delivery
    uses platform-specific adapters where WE control frequency and timing.
    MCP tools are user-initiated — the user decides when to show ads,
    which goes against our business model of controlling ad delivery.

    Args:
        text:    The LLM response you're about to display.
        style:   Footer format — "markdown" (default), "cli", or "telegram".
        context: Topic hint for ad targeting (e.g. "defi", "coding").

    Returns:
        {text: str, injected: bool}
    """
    if not config.enabled or not config.wallet:
        return {"text": text, "injected": False}

    from .footer import FrequencyCounter, format_footer

    # Per-tool frequency counter (persists across calls in this process)
    if not hasattr(inject_footer, "_counter"):
        inject_footer._counter = FrequencyCounter(config.frequency)  # type: ignore[attr-defined]
    if not inject_footer._counter.tick():  # type: ignore[attr-defined]
        return {"text": text, "injected": False}

    from .delivery import confirm_if_displayed, reserve_ad

    ad = reserve_ad(
        client,
        wallet=config.wallet,
        context=context or "general",
        agent="mcp",
        surface="response_footer",
    )
    if not ad:
        return {"text": text, "injected": False}

    allowed = {"markdown", "cli", "telegram"}
    footer = format_footer(ad, style=style if style in allowed else "markdown")
    out = text + footer
    confirm_if_displayed(tracker, ad, config.wallet, out)
    return {"text": out, "injected": True}


@mcp.tool()
def platform_info() -> dict:
    """Detect the current agent platform and return integration instructions.

    Returns:
        {platform, style, instructions, example_code}
    """
    from .adapters.unified import STYLE_MAP, detect_platform

    platform = detect_platform()
    instructions = {
        "hermes": (
            "Call UnifiedAdapter().register(ctx) inside your Hermes plugin "
            "register() function."
        ),
        "telegram": (
            "Call adapter.wrap_response(text, context=msg.text, user_id=str(uid)) "
            "before sending each bot reply."
        ),
        "cli": (
            "Decorate your response function with @adapter.inject, or call "
            "adapter.wrap(text) directly."
        ),
        "mcp": (
            "MCP mode: request_ad and inject_footer are TEST ONLY. "
            "For production, use platform-specific adapters (Hermes plugin, "
            "Claude Code hooks, Telegram adapter) where WE control ad delivery."
        ),
    }
    examples = {
        "hermes": (
            "from latent_protocol.adapters.unified import UnifiedAdapter\n"
            "def register(ctx):\n"
            "    UnifiedAdapter().register(ctx)"
        ),
        "telegram": (
            "from latent_protocol.adapters.unified import UnifiedAdapter\n"
            "adapter = UnifiedAdapter()\n"
            "async def reply(update, ctx):\n"
            "    text = await llm(update.message.text)\n"
            "    await update.message.reply_text(\n"
            "        adapter.wrap_response(text,\n"
            "            context=update.message.text,\n"
            "            user_id=str(update.effective_user.id)),\n"
            "        parse_mode='Markdown')"
        ),
        "cli": (
            "from latent_protocol.adapters.unified import UnifiedAdapter\n"
            "adapter = UnifiedAdapter()\n\n"
            "@adapter.inject\n"
            "def ask(prompt: str) -> str:\n"
            "    return call_llm(prompt)"
        ),
        "mcp": (
            '# Add to claude_desktop_config.json / mcp.json:\n'
            '{\n'
            '  "mcpServers": {\n'
            '    "latent-protocol": {\n'
            '      "command": "latent-mcp"\n'
            '    }\n'
            '  }\n'
            '}'
        ),
    }
    return {
        "platform": platform,
        "style": STYLE_MAP.get(platform, "markdown"),
        "instructions": instructions.get(platform, ""),
        "example_code": examples.get(platform, ""),
    }


def main() -> None:
    """Console-script entry point (stdio transport)."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
