"""Billing integrity — reserve must not bill; confirm only when displayed."""

from unittest.mock import MagicMock

from latent_protocol.delivery import (
    already_displayed,
    confirm_display,
    confirm_if_displayed,
    reserve_ad,
)


def test_already_displayed_markers():
    assert already_displayed("hello\n💰 Sponsored: x")
    assert already_displayed("*Sponsored:* x")
    assert already_displayed("**Sponsored:** x")
    assert not already_displayed("just a normal reply")


def test_reserve_ad_does_not_bill():
    client = MagicMock()
    client.get_ad.return_value = {
        "ad_id": "a1",
        "body": "Hi",
        "impression_token": "tok",
    }
    ad = reserve_ad(
        client, wallet="0xABC", context="defi", agent="hermes", surface="thinking_state"
    )
    assert ad["ad_id"] == "a1"
    client.get_ad.assert_called_once()


def test_reserve_ad_classifies_context_locally_never_forwards_raw_text():
    """C4 regression: several adapters pass the raw user message / assistant
    response as `context` (see e.g. adapters/telegram.py's docstring). Only a
    classified category slug may reach the ad server — never that raw text."""
    client = MagicMock()
    client.get_ad.return_value = {"ad_id": "a1"}
    secret_message = "my api key is sk-live-abc123, help me write a fastapi jwt auth endpoint"

    reserve_ad(client, wallet="0xABC", context=secret_message, agent="hermes", surface="thinking_state")

    sent_context = client.get_ad.call_args.kwargs["context"]
    assert sent_context != secret_message
    assert secret_message not in sent_context
    assert sent_context == "backend"


def test_confirm_display_posts_impression():
    tracker = MagicMock()
    ad = {"ad_id": "a1", "impression_token": "tok"}
    assert confirm_display(tracker, ad, "0xABC") is True
    tracker.log_impression.assert_called_once_with("a1", "0xABC", "tok")


def test_confirm_if_displayed_requires_marker():
    tracker = MagicMock()
    ad = {"ad_id": "a1", "impression_token": "tok"}
    assert confirm_if_displayed(tracker, ad, "0xABC", "no ad here") is False
    tracker.log_impression.assert_not_called()
    assert confirm_if_displayed(tracker, ad, "0xABC", "💰 Sponsored: Hi") is True
    tracker.log_impression.assert_called_once()
