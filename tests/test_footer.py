"""Unit tests for the shared footer + frequency helpers (no I/O)."""

from latent_protocol.footer import FrequencyCounter, format_footer

AD = {
    "id": "abc",
    "body": "Trade on BaseSwap",
    "cta_text": "Start",
    "cta_url": "https://x.io",
    "earn_amount": 0.005,
}


def test_markdown_footer_contains_core_fields():
    out = format_footer(AD, style="markdown")
    assert "Sponsored" in out and AD["body"] in out
    assert AD["cta_url"] in out and "0.005" in out
    assert out.startswith("\n\n> " + AD["body"])  # the ad leads, not the label
    assert out.endswith("· _Sponsored: +$0.005 USDC_") and "💰" not in out
    assert "\n" not in out.strip("\n")  # one line


def test_telegram_footer_format():
    out = format_footer(AD, style="telegram")
    assert out.startswith("\n\n" + AD["body"])
    assert out.endswith("_Sponsored: +$0.005 USDC_") and "💰" not in out


def test_cli_footer_has_ansi():
    out = format_footer(AD, style="cli")
    assert AD["cta_url"] in out and "Sponsored: +$0.005 USDC" in out
    assert "\033[2m" in out and "\033[33m" not in out  # dim tag, no loud colour


def test_unknown_style_falls_back_to_markdown():
    assert format_footer(AD, style="bogus") == format_footer(AD, style="markdown")


def test_sanitizes_ansi_injection_in_ad_copy_every_style():
    """Every adapter used to render body/cta_text raw — a malicious advertiser
    could inject terminal escapes (cli style) or break the chat message
    (telegram/markdown). None of them sanitized until this fix.

    ``cli`` style legitimately contains its own ESC bytes (the yellow/dim
    color codes) — assert the specific injected sequences are gone, not
    "no ESC anywhere".
    """
    malicious = {
        "id": "evil",
        "body": "\x1b[2J\x1b[H PWNED",
        "cta_text": "\x1b]0;evil\x07Click",
        "cta_url": "https://acme.example",
        "earn_amount": 0.01,
    }
    for style in ("markdown", "telegram", "cli"):
        out = format_footer(malicious, style=style)
        assert "\x1b[2J" not in out
        assert "\x1b]0;evil" not in out
        assert "PWNED" in out  # sanitized visible, not silently dropped


def test_unsafe_cta_url_never_becomes_a_link():
    ad = {"id": "1", "body": "hi", "cta_text": "go", "cta_url": "javascript:alert(1)"}
    for style in ("markdown", "telegram", "cli"):
        out = format_footer(ad, style=style)
        assert "javascript:" not in out


def test_frequency_counter_fires_every_n():
    c = FrequencyCounter(every=3)
    results = [c.tick() for _ in range(6)]
    assert results == [False, False, True, False, False, True]


def test_frequency_counter_minimum_one():
    c = FrequencyCounter(every=0)  # clamped to 1
    assert c.tick() is True and c.tick() is True
