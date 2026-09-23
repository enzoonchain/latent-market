"""Tests for the Claude Code statusLine adapter (rotation + impression hygiene)."""

import json
from unittest.mock import MagicMock, patch

import pytest

from latent_protocol.adapters import claude_code as cc
from latent_protocol.config import Config


FAKE_AD = {
    "ad_id": "ad-1",
    "body": "Try Acme!",
    "cta_text": "Learn more",
    "cta_url": "https://acme.io",
    "earn_amount": 0.0025,
    "impression_token": "tok-abc",
}


def _cfg(**kw):
    defaults = dict(
        enabled=True,
        wallet="0xDEADBEEF",
        server="http://localhost:8000",
        frequency=5,
        min_payout=5.0,
        categories=["all"],
    )
    defaults.update(kw)
    return Config(**defaults)


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolate cache + settings to tmp and stub network/config."""
    monkeypatch.setattr(cc, "_CONFIG_DIR", tmp_path)
    monkeypatch.setattr(cc, "_CACHE_FILE", tmp_path / "statusline_cache.json")
    monkeypatch.setattr(cc, "_CLAUDE_SETTINGS", tmp_path / "claude" / "settings.json")
    monkeypatch.setenv("ADS_STATUSLINE_ROTATE", "30")
    client = MagicMock()
    client.get_ad.return_value = FAKE_AD
    tracker = MagicMock()
    monkeypatch.setattr(cc, "AdClient", lambda *a, **k: client)
    monkeypatch.setattr(cc, "Tracker", lambda *a, **k: tracker)
    return client, tracker


# ── render ───────────────────────────────────────────────────────────────────

def test_disabled_returns_empty(env, monkeypatch):
    monkeypatch.setattr(cc.Config, "from_env", staticmethod(lambda: _cfg(enabled=False)))
    assert cc.render({"session_id": "s1"}) == ""
    env[0].get_ad.assert_not_called()


def test_no_wallet_returns_empty(env, monkeypatch):
    monkeypatch.setattr(cc.Config, "from_env", staticmethod(lambda: _cfg(wallet="")))
    assert cc.render({"session_id": "s1"}) == ""


def test_fetches_and_logs_impression(env, monkeypatch):
    client, tracker = env
    monkeypatch.setattr(cc.Config, "from_env", staticmethod(lambda: _cfg()))
    line = cc.render({"session_id": "s1", "prompt": "defi"})
    assert "Acme" in line
    assert "Sponsored: +$" in line and "💰" not in line
    assert "https://acme.io" in line  # OSC 8 link target
    client.get_ad.assert_called_once()
    assert client.get_ad.call_args.kwargs["surface"] == "status_line"
    tracker.log_impression.assert_called_once_with("ad-1", "0xDEADBEEF", "tok-abc")


def test_reuses_cache_within_rotation_window(env, monkeypatch):
    client, tracker = env
    monkeypatch.setattr(cc.Config, "from_env", staticmethod(lambda: _cfg()))
    times = iter([1000.0, 1005.0, 1009.0])  # all within 30s window
    monkeypatch.setattr(cc.time, "time", lambda: next(times))
    cc.render({"session_id": "s1"})
    cc.render({"session_id": "s1"})
    cc.render({"session_id": "s1"})
    # Only the first refresh fetched + billed; the rest reused the cache.
    assert client.get_ad.call_count == 1
    assert tracker.log_impression.call_count == 1


def test_refetches_after_rotation_window(env, monkeypatch):
    client, tracker = env
    monkeypatch.setattr(cc.Config, "from_env", staticmethod(lambda: _cfg()))
    times = iter([1000.0, 1040.0])  # second call is >30s later
    monkeypatch.setattr(cc.time, "time", lambda: next(times))
    cc.render({"session_id": "s1"})
    cc.render({"session_id": "s1"})
    assert client.get_ad.call_count == 2
    assert tracker.log_impression.call_count == 2


def test_no_ad_returns_empty(env, monkeypatch):
    client, _ = env
    client.get_ad.return_value = None
    monkeypatch.setattr(cc.Config, "from_env", staticmethod(lambda: _cfg()))
    assert cc.render({"session_id": "s1"}) == ""


# ── install / uninstall ──────────────────────────────────────────────────────

def test_install_writes_settings(env):
    cc.install(refresh_interval=15)
    data = json.loads(cc._CLAUDE_SETTINGS.read_text())
    assert data["statusLine"]["command"] == "latent-statusline"
    assert data["statusLine"]["refreshInterval"] == 15


def test_install_is_non_destructive(env):
    cc._CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    cc._CLAUDE_SETTINGS.write_text(json.dumps({"theme": "dark"}))
    cc.install()
    data = json.loads(cc._CLAUDE_SETTINGS.read_text())
    assert data["theme"] == "dark"  # preserved
    assert data["statusLine"]["command"] == "latent-statusline"


def test_uninstall_removes_only_ours(env):
    cc._CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    cc._CLAUDE_SETTINGS.write_text(
        json.dumps({"theme": "dark", "statusLine": {"command": "latent-statusline"}})
    )
    cc.uninstall()
    data = json.loads(cc._CLAUDE_SETTINGS.read_text())
    assert "statusLine" not in data
    assert data["theme"] == "dark"


def test_osc8_only_for_safe_https():
    # Safe https → wrapped in OSC 8 escape.
    link = cc._osc8_link("Buy →", "https://acme.io")
    assert "\033]8;;https://acme.io\033\\" in link
    assert "Buy →" in link


@pytest.mark.parametrize(
    "url",
    [
        "http://acme.io",            # not https
        "javascript:alert(1)",        # dangerous scheme
        "data:text/html,<x>",         # dangerous scheme
        "file:///etc/passwd",         # dangerous scheme
        "https://a\033]8;;evil\033\\", # embedded escape breaker
        "",                           # empty
        None,                         # missing
    ],
)
def test_osc8_falls_back_to_plain_text_for_unsafe(url):
    assert cc._is_safe_url(url) is False
    out = cc._osc8_link("Buy →", url)  # type: ignore[arg-type]
    assert out == "Buy →"           # plain text, no OSC 8 escape
    assert "\033]8;;" not in out


def test_statusline_with_unsafe_url_has_no_osc8(env, monkeypatch):
    bad_ad = {**FAKE_AD, "cta_url": "javascript:steal()"}
    env[0].get_ad.return_value = bad_ad
    monkeypatch.setattr(cc.Config, "from_env", staticmethod(lambda: _cfg()))
    line = cc.render({"session_id": "s1"})
    assert "Acme" in line
    assert "\033]8;;" not in line  # no clickable link emitted


def test_format_statusline_sanitizes_ansi_injection_in_ad_copy():
    """`body`/`cta_text` are advertiser-controlled and used to go straight
    into a real terminal's status line with zero sanitization — a malicious
    advertiser could inject arbitrary terminal escapes (clear screen, set
    title, worse). This is the terminal analogue of latent-protocol#18.

    The status line does legitimately contain ESC bytes of its own (the safe
    OSC 8 hyperlink around a valid https cta_url) — so assert on the specific
    injected sequences being gone, not "no ESC at all".
    """
    malicious_ad = {
        **FAKE_AD,
        "body": "\x1b[2J\x1b[H PWNED",
        "cta_text": "\x1b]0;evil\x07Click",
    }
    line = cc.format_statusline(malicious_ad)
    assert "\x1b[2J" not in line
    assert "\x1b]0;evil" not in line
    assert "PWNED" in line  # sanitized visible, not silently dropped


def test_render_end_to_end_neutralizes_a_malicious_ad(env, monkeypatch):
    bad_ad = {**FAKE_AD, "body": "\x1b[2J\x1b[H PWNED", "cta_text": "\x1b]0;evil\x07Click"}
    env[0].get_ad.return_value = bad_ad
    monkeypatch.setattr(cc.Config, "from_env", staticmethod(lambda: _cfg()))
    line = cc.render({"session_id": "s1"})
    assert "\x1b[2J" not in line
    assert "\x1b]0;evil" not in line


def test_uninstall_leaves_foreign_statusline(env):
    cc._CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    cc._CLAUDE_SETTINGS.write_text(json.dumps({"statusLine": {"command": "other-tool"}}))
    cc.uninstall()
    data = json.loads(cc._CLAUDE_SETTINGS.read_text())
    assert data["statusLine"]["command"] == "other-tool"  # untouched
