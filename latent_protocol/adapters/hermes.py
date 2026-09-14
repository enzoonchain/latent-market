"""Hermes push adapter — reserve during think, confirm only if shown.

Billing integrity
-----------------
``pre_llm_call`` / ``get_ad`` never bill. Impression POSTs run only when we
observe the sponsored footer in text Hermes is actually delivering
(``post_llm_call``) or when a legacy ``post_response`` hook successfully
appends it. ``transform_llm_output`` may attach the footer but does **not**
bill on its own — streaming builds can drop that return value.
"""

from ..ad_client import AdClient
from ..config import Config
from ..delivery import (
    already_displayed,
    confirm_display,
    reserve_ad,
)
from ..footer import FrequencyCounter, format_footer
from ..tracker import Tracker
from .. import wallet as wallet_api


def _style_for_channel(channel: str | None) -> str:
    """Map a Hermes delivery channel to a footer render style."""
    c = (channel or "").lower()
    if "telegram" in c:
        return "telegram"
    if any(k in c for k in ("tui", "cli", "term")):
        return "cli"
    return "markdown"


def _turn_key(session_id) -> str:
    return session_id if session_id is not None else ""


def register(ctx) -> None:
    """Entry point called by the Hermes plugin system."""
    config = Config.from_env()
    client = AdClient(config.server)
    tracker = Tracker(config.server)
    counter = FrequencyCounter(config.frequency)

    #   "pending" → reserved; footer hooks render this creative.
    #   "skip"    → frequency said not this turn.
    turn_state: dict[str, str] = {}
    pending_ads: dict[str, dict] = {}
    confirmed_turns: set[str] = set()

    last_ad: dict[str, str | None] = {"id": None, "click_token": None}

    def _reserve(text: str, surface: str) -> dict | None:
        ad = reserve_ad(
            client,
            wallet=config.wallet,
            context=text or "general",
            agent="hermes",
            surface=surface,
        )
        if not ad:
            return None
        last_ad["id"] = ad.get("ad_id") or ad.get("id") or None
        last_ad["click_token"] = ad.get("click_token") or None
        return ad

    def _resolve_ad(text: str, session_id=None) -> dict | None:
        key = _turn_key(session_id)
        state = turn_state.get(key)
        if state == "skip":
            return None
        if state == "pending" or key in pending_ads:
            return pending_ads.get(key)
        if not counter.tick():
            turn_state[key] = "skip"
            return None
        ad = _reserve(text, surface="response_footer")
        if not ad:
            turn_state[key] = "skip"
            return None
        turn_state[key] = "pending"
        pending_ads[key] = ad
        return ad

    def _confirm(ad: dict | None, session_id=None) -> None:
        key = _turn_key(session_id)
        if key in confirmed_turns:
            return
        if confirm_display(tracker, ad, config.wallet):
            confirmed_turns.add(key)

    def _clear_turn(session_id=None) -> None:
        key = _turn_key(session_id)
        turn_state.pop(key, None)
        pending_ads.pop(key, None)
        # confirmed_turns only dedups confirms *within* this turn (in case both
        # post_llm_call and post_response fire for it) — drop the key here so
        # the session can bill again on its next turn.
        confirmed_turns.discard(key)
        if len(confirmed_turns) > 256:
            confirmed_turns.clear()

    def pre_llm_call(session_id=None, user_message="", **kwargs):
        if not config.enabled or not config.wallet:
            return None
        key = _turn_key(session_id)
        if not counter.tick():
            turn_state[key] = "skip"
            pending_ads.pop(key, None)
            return None
        ad = _reserve(user_message, surface="thinking_state")
        if not ad:
            turn_state[key] = "skip"
            pending_ads.pop(key, None)
            return None
        turn_state[key] = "pending"
        pending_ads[key] = ad
        return None  # reserve only — never inject invisible LLM context

    def transform_llm_output(response_text, session_id=None, channel=None, platform=None, **kwargs):
        """Attach footer. Does not bill — wait for post_llm_call / post_response."""
        if not config.enabled or not config.wallet:
            return None
        text = response_text or ""
        if already_displayed(text):
            return None
        key = _turn_key(session_id)
        if turn_state.get(key) == "skip":
            return None
        ad = _resolve_ad(text, session_id)
        if not ad:
            return None
        return text + format_footer(ad, style=_style_for_channel(channel or platform))

    def post_llm_call(
        session_id=None,
        assistant_response="",
        response_text="",
        **kwargs,
    ):
        """Bill only if Hermes's delivered assistant text contains the footer."""
        if not config.enabled or not config.wallet:
            return None
        text = assistant_response or response_text or ""
        key = _turn_key(session_id)
        ad = pending_ads.get(key)
        if already_displayed(text):
            _confirm(ad, session_id)
        # If transform was dropped, text has no footer — do not bill.
        # Leave pending for post_response recovery when that hook exists.
        return None

    def post_response(text, session_id=None, channel=None, platform=None, **kwargs):
        """Legacy delivery hook: ensure footer is present, then confirm."""
        text = text or ""
        if not config.enabled or not config.wallet:
            _clear_turn(session_id)
            return text
        key = _turn_key(session_id)
        if turn_state.get(key) == "skip":
            _clear_turn(session_id)
            return text
        if already_displayed(text):
            _confirm(pending_ads.get(key), session_id)
            _clear_turn(session_id)
            return text
        ad = _resolve_ad(text, session_id)
        if not ad:
            _clear_turn(session_id)
            return text
        out = text + format_footer(ad, style=_style_for_channel(channel or platform))
        _confirm(ad, session_id)
        _clear_turn(session_id)
        return out

    for hook_name, fn in (
        ("pre_llm_call", pre_llm_call),
        ("transform_llm_output", transform_llm_output),
        ("post_llm_call", post_llm_call),
        ("post_response", post_response),
    ):
        try:
            ctx.register_hook(hook_name, fn)
        except Exception:
            pass

    _register_command(ctx, config, tracker, last_ad)


def _register_command(ctx, config: Config, tracker: Tracker, last_ad: dict) -> None:
    """`/ads on|off|click|balance|payout|settings` — delegates to the shared core."""

    def handle(args):
        cmd = (args or "").strip().lower()
        wallet = config.wallet

        if cmd == "click":
            ad_id = last_ad.get("id")
            if not ad_id:
                return "ℹ️ No recent sponsored ad to click."
            if not wallet:
                return "❌ No wallet configured."
            tracker.log_click(ad_id, wallet, last_ad.get("click_token") or "")
            return "✅ Thanks! Click registered — you earn more for clicks."
        if cmd == "off":
            config.enabled = False
            return "❌ Ads disabled. Use `/ads on` to re-enable."
        if cmd == "on":
            config.enabled = True
            return "✅ Ads enabled."
        if cmd == "balance":
            if not wallet:
                return "❌ No wallet configured. Set `ADS_WALLET`."
            bal = wallet_api.get_balance(wallet, config.server)
            return f"💰 Balance: ${bal:.4f} USDC"
        if cmd == "payout":
            if not wallet:
                return "❌ No wallet configured."
            bal = wallet_api.get_balance(wallet, config.server)
            if bal >= config.min_payout:
                tx = wallet_api.request_payout(wallet, config.server)
                return f"💸 Payout sent! ${bal:.4f} USDC → {wallet}\nTx: {tx}"
            return f"❌ Minimum ${config.min_payout:.2f}. Current: ${bal:.4f}"
        if cmd == "settings":
            return (
                "⚙️ **Ad Settings**\n"
                f"- Wallet: `{wallet or 'not set'}`\n"
                f"- Enabled: {'✅' if config.enabled else '❌'}\n"
                f"- Frequency: every {config.frequency} messages\n"
                f"- Server: {config.server}"
            )
        if cmd == "setup generate":
            from .. import setup as setup_mod
            addr, private_key = setup_mod.generate_wallet()
            setup_mod.save_config_file({"wallet": addr})
            config.wallet = addr
            return (
                "✅ **New wallet generated!**\n\n"
                f"- **Address:** `{addr}`\n"
                f"- **Private key:** `{private_key}`\n\n"
                "⚠️ **Save your private key now** — it won't be shown again.\n"
                "Import it into MetaMask or any EVM wallet to access your USDC earnings.\n\n"
                "Your agent will now earn USDC from sponsored ads. "
                "Check earnings with `/ads balance`."
            )
        if cmd.startswith("setup use "):
            from .. import setup as setup_mod
            addr = cmd.removeprefix("setup use ").strip()
            if not setup_mod.is_valid_address(addr):
                return "❌ Invalid address. Must be `0x` followed by 40 hex characters."
            setup_mod.save_config_file({"wallet": addr})
            config.wallet = addr
            return (
                f"✅ Wallet set to `{addr}`\n"
                "Your agent will now earn USDC from sponsored ads. "
                "Check earnings with `/ads balance`."
            )
        if cmd.startswith("setup"):
            current = f"`{wallet}`" if wallet else "not set"
            return (
                "🔧 **Wallet Setup**\n\n"
                f"Current wallet: {current}\n\n"
                "**Options:**\n"
                "- `/ads setup generate` — create a new wallet automatically\n"
                "- `/ads setup use 0x...` — use your existing wallet address\n\n"
                "You only need to do this once. Earnings are paid in USDC on Base."
            )
        return (
            "**Ads Commands:**\n"
            "- `/ads setup` — configure your earning wallet\n"
            "- `/ads on` — enable ads\n"
            "- `/ads off` — disable ads\n"
            "- `/ads click` — register a click on the last ad (earn more)\n"
            "- `/ads balance` — check earnings\n"
            "- `/ads payout` — withdraw earnings\n"
            "- `/ads settings` — view config"
        )

    try:
        ctx.register_command("ads", handle, "Manage ads: /ads [on|off|click|balance|payout|settings]")
    except Exception:
        pass
