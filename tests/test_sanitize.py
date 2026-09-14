"""Unit tests for the advertiser-text sanitizer (no adapter ever had one before)."""

from latent_protocol.sanitize import is_safe_https_url, sanitize_ad_text


def test_strips_ansi_escape_sequences():
    assert sanitize_ad_text("\x1b[2J\x1b[Hpwned") == "pwned"
    assert sanitize_ad_text("\x1b]0;evil title\x07visible") == "visible"


def test_strips_raw_control_chars_without_a_recognised_sequence():
    out = sanitize_ad_text("a\x01\x02\x9bz")
    assert not any(ord(c) < 0x20 or ord(c) in (0x7F,) or 0x7F <= ord(c) <= 0x9F for c in out)


def test_strips_bidi_override_codepoints():
    assert sanitize_ad_text("safe‮text‬") == "safetext"


def test_collapses_whitespace_and_clamps_with_ellipsis():
    assert sanitize_ad_text("a   b\n\nc") == "a b c"
    out = sanitize_ad_text("x" * 200, 10)
    assert len(out) <= 10
    assert out.endswith("…")


def test_preserves_plain_unicode():
    assert sanitize_ad_text("Café — 50% off") == "Café — 50% off"


def test_none_and_empty():
    assert sanitize_ad_text(None) == ""
    assert sanitize_ad_text("") == ""


def test_is_safe_https_url():
    assert is_safe_https_url("https://acme.example") is True
    assert is_safe_https_url("http://acme.example") is False
    assert is_safe_https_url("javascript:alert(1)") is False
    assert is_safe_https_url("https://acme.example/\x1b") is False
    assert is_safe_https_url(None) is False
