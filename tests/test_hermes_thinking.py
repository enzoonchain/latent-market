"""Tests for Hermes reserve → footer → confirm-only-if-shown."""

from unittest.mock import MagicMock, patch

from latent_protocol.adapters import hermes
from latent_protocol.config import Config


FAKE_AD = {
    "ad_id": "ad-1",
    "body": "Try Acme!",
    "cta_text": "Learn more",
    "cta_url": "https://acme.io",
    "earn_amount": 0.0025,
    "impression_token": "tok-abc",
    "click_token": "click-tok-abc",
}


class FakeCtx:
    def __init__(self):
        self.hooks = {}
        self.commands = {}

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_command(self, name, fn, desc=""):
        self.commands[name] = fn


def _register(frequency=1, ad=FAKE_AD):
    cfg = Config(
        enabled=True,
        wallet="0xDEADBEEF",
        server="http://localhost:8000",
        frequency=frequency,
        min_payout=5.0,
        categories=["all"],
    )
    client = MagicMock()
    client.get_ad.return_value = ad
    tracker = MagicMock()
    ctx = FakeCtx()
    with patch.object(hermes.Config, "from_env", return_value=cfg), \
         patch.object(hermes, "AdClient", return_value=client), \
         patch.object(hermes, "Tracker", return_value=tracker):
        hermes.register(ctx)
    return ctx, client, tracker


def test_all_hooks_registered():
    ctx, _, _ = _register()
    assert "pre_llm_call" in ctx.hooks
    assert "transform_llm_output" in ctx.hooks
    assert "post_llm_call" in ctx.hooks
    assert "post_response" in ctx.hooks
    assert "ads" in ctx.commands


def test_reserve_does_not_bill():
    ctx, client, tracker = _register(frequency=1)
    out = ctx.hooks["pre_llm_call"](session_id="s1", user_message="defi help")
    assert out is None
    client.get_ad.assert_called_once()
    tracker.log_impression.assert_not_called()


def test_transform_does_not_bill_until_delivery_observed():
    ctx, client, tracker = _register(frequency=1)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi")
    result = ctx.hooks["transform_llm_output"]("response", session_id="s1")
    assert "Sponsored" in result
    tracker.log_impression.assert_not_called()
    # Hermes delivered the transformed text → bill once.
    ctx.hooks["post_llm_call"](session_id="s1", assistant_response=result)
    tracker.log_impression.assert_called_once_with("ad-1", "0xDEADBEEF", "tok-abc")


def test_no_bill_when_transform_dropped():
    """If streaming drops the footer, post_llm_call sees raw text → no bill."""
    ctx, client, tracker = _register(frequency=1)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi")
    ctx.hooks["transform_llm_output"]("response", session_id="s1")
    ctx.hooks["post_llm_call"](session_id="s1", assistant_response="response")
    tracker.log_impression.assert_not_called()


def test_post_response_recovers_display_and_bills():
    ctx, client, tracker = _register(frequency=1)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi")
    ctx.hooks["transform_llm_output"]("response", session_id="s1")
    # Transform dropped; post_llm_call saw no footer.
    ctx.hooks["post_llm_call"](session_id="s1", assistant_response="response")
    tracker.log_impression.assert_not_called()
    # Legacy/safety hook re-attaches and bills.
    delivered = ctx.hooks["post_response"]("response", session_id="s1")
    assert "Acme" in delivered
    tracker.log_impression.assert_called_once_with("ad-1", "0xDEADBEEF", "tok-abc")


def test_post_response_bills_when_only_recovery_path_runs():
    ctx, client, tracker = _register(frequency=1)
    delivered = ctx.hooks["post_response"]("response", session_id="s1")
    assert "Sponsored" in delivered
    tracker.log_impression.assert_called_once()


def test_no_double_bill_transform_then_post_response():
    ctx, client, tracker = _register(frequency=1)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi")
    result = ctx.hooks["transform_llm_output"]("response", session_id="s1")
    ctx.hooks["post_llm_call"](session_id="s1", assistant_response=result)
    again = ctx.hooks["post_response"](result, session_id="s1")
    assert again.count("Sponsored") == 1
    tracker.log_impression.assert_called_once()


def test_footer_skipped_when_thinking_throttled():
    ctx, client, tracker = _register(frequency=2)
    assert ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi") is None
    assert ctx.hooks["transform_llm_output"]("response", session_id="s1") is None
    assert ctx.hooks["post_response"]("response", session_id="s1") == "response"
    client.get_ad.assert_not_called()
    tracker.log_impression.assert_not_called()


def test_ads_click_registers_last_ad():
    ctx, client, tracker = _register(frequency=1)
    ctx.hooks["pre_llm_call"](session_id="s1", user_message="hi")
    msg = ctx.commands["ads"]("click")
    assert "registered" in msg.lower()
    tracker.log_click.assert_called_once_with("ad-1", "0xDEADBEEF", "click-tok-abc")


def test_ads_click_without_recent_ad():
    ctx, client, tracker = _register(frequency=1)
    msg = ctx.commands["ads"]("click")
    assert "no recent" in msg.lower()
    tracker.log_click.assert_not_called()


def test_footer_fallback_when_pre_llm_never_fires():
    ctx, client, tracker = _register(frequency=1)
    result = ctx.hooks["transform_llm_output"]("response", session_id="s1")
    assert "Acme" in result
    assert client.get_ad.call_args.kwargs["surface"] == "response_footer"
    tracker.log_impression.assert_not_called()
    ctx.hooks["post_llm_call"](session_id="s1", assistant_response=result)
    tracker.log_impression.assert_called_once()


def test_style_for_channel_mapping():
    assert hermes._style_for_channel("telegram") == "telegram"
    assert hermes._style_for_channel("tui") == "cli"
    assert hermes._style_for_channel(None) == "markdown"


def test_footer_telegram_style():
    ctx, client, tracker = _register(frequency=1)
    out = ctx.hooks["transform_llm_output"]("resp", session_id="s1", channel="telegram")
    assert "*Sponsored:*" in out


def test_footer_tui_uses_ansi():
    ctx, client, tracker = _register(frequency=1)
    out = ctx.hooks["transform_llm_output"]("resp", session_id="s1", platform="tui")
    assert "\033[33m" in out
