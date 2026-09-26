"""Tests for the UnifiedAdapter and platform detection."""

import os
from unittest.mock import MagicMock, patch

import pytest

from latent_protocol.adapters.unified import UnifiedAdapter, detect_platform
from latent_protocol.config import Config


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cfg(**kwargs):
    defaults = dict(
        enabled=True,
        wallet="0xDEADBEEF",
        server="http://localhost:8000",
        frequency=1,
        min_payout=5.0,
        categories=["all"],
    )
    defaults.update(kwargs)
    return Config(**defaults)


def _adapter(platform="cli", **cfg_kwargs):
    return UnifiedAdapter(config=_cfg(**cfg_kwargs), platform=platform)


# ---------------------------------------------------------------------------
# detect_platform
# ---------------------------------------------------------------------------

class TestDetectPlatform:
    def test_explicit_env_var(self, monkeypatch):
        monkeypatch.setenv("LATENT_PLATFORM", "telegram")
        assert detect_platform() == "telegram"

    def test_hermes_env_var(self, monkeypatch):
        monkeypatch.delenv("LATENT_PLATFORM", raising=False)
        monkeypatch.setenv("HERMES_PLUGIN", "1")
        assert detect_platform() == "hermes"

    def test_telegram_env_var(self, monkeypatch):
        monkeypatch.delenv("LATENT_PLATFORM", raising=False)
        monkeypatch.delenv("HERMES_PLUGIN", raising=False)
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
        assert detect_platform() == "telegram"

    def test_claude_code_env_var(self, monkeypatch):
        monkeypatch.delenv("LATENT_PLATFORM", raising=False)
        monkeypatch.delenv("HERMES_PLUGIN", raising=False)
        monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
        monkeypatch.setenv("CLAUDE_CODE", "1")
        assert detect_platform() == "mcp"

    def test_invalid_explicit_falls_through(self, monkeypatch):
        monkeypatch.setenv("LATENT_PLATFORM", "unknown_platform")
        # Should not crash; falls through to auto-detect
        result = detect_platform()
        assert result in ("hermes", "telegram", "cli", "mcp")


# ---------------------------------------------------------------------------
# UnifiedAdapter.wrap
# ---------------------------------------------------------------------------

FAKE_AD = {
    "id": "ad-1",
    "body": "Try Acme!",
    "cta_text": "Learn more",
    "cta_url": "https://acme.io",
    "earn_amount": 0.0025,
    "impression_token": "tok-abc",
}


class TestWrap:
    def _make(self, platform="cli", ad=FAKE_AD):
        adapter = _adapter(platform=platform, frequency=1)
        adapter._client = MagicMock()
        adapter._client.get_ad.return_value = ad
        adapter._tracker = MagicMock()
        return adapter

    def test_appends_footer_on_cli(self):
        adapter = self._make(platform="cli")
        result = adapter.wrap("Hello", context="defi")
        assert "Hello" in result
        assert "Acme" in result
        assert "\033[2m" in result  # dim ANSI tag in CLI style

    def test_appends_footer_on_markdown(self):
        adapter = self._make(platform="mcp")
        result = adapter.wrap("Hello", context="defi")
        assert "\n\n> " in result and "_Sponsored: +$" in result

    def test_appends_footer_on_telegram(self):
        adapter = self._make(platform="telegram")
        result = adapter.wrap("Hello", context="defi")
        assert "_Sponsored: +$" in result and "\n\n> " not in result

    def test_no_footer_when_disabled(self):
        adapter = _adapter(platform="cli", enabled=False)
        adapter._client = MagicMock()
        result = adapter.wrap("Hello")
        assert result == "Hello"
        adapter._client.get_ad.assert_not_called()

    def test_no_footer_when_no_wallet(self):
        adapter = _adapter(platform="cli", wallet="")
        adapter._client = MagicMock()
        result = adapter.wrap("Hello")
        assert result == "Hello"

    def test_no_footer_when_no_ad(self):
        adapter = _adapter(platform="cli", frequency=1)
        adapter._client = MagicMock()
        adapter._client.get_ad.return_value = None
        result = adapter.wrap("Hello")
        assert result == "Hello"

    def test_frequency_throttle(self):
        adapter = _adapter(platform="cli", frequency=3)
        adapter._client = MagicMock()
        adapter._client.get_ad.return_value = FAKE_AD
        adapter._tracker = MagicMock()
        results = [adapter.wrap(f"msg{i}") for i in range(6)]
        # With frequency=3: ad shown on call 3 and 6 (count % 3 == 0)
        shown = [r for r in results if "Acme" in r]
        assert len(shown) == 2

    def test_impression_logged(self):
        adapter = self._make(platform="cli")
        adapter.wrap("Hello", context="defi")
        adapter._tracker.log_impression.assert_called_once_with(
            "ad-1", "0xDEADBEEF", "tok-abc", event_uuid=None
        )


# ---------------------------------------------------------------------------
# UnifiedAdapter.register (Hermes guard)
# ---------------------------------------------------------------------------

class TestRegister:
    def test_raises_if_not_hermes(self):
        adapter = _adapter(platform="cli")
        with pytest.raises(RuntimeError, match="hermes"):
            adapter.register(MagicMock())

    def test_delegates_to_hermes_adapter(self):
        adapter = _adapter(platform="hermes")
        ctx = MagicMock()
        with patch("latent_protocol.adapters.hermes.register") as mock_reg:
            adapter.register(ctx)
            mock_reg.assert_called_once_with(ctx)


# ---------------------------------------------------------------------------
# UnifiedAdapter.status
# ---------------------------------------------------------------------------

class TestStatus:
    def test_status_fields(self):
        adapter = _adapter(platform="telegram")
        s = adapter.status()
        assert s["platform"] == "telegram"
        assert s["style"] == "telegram"
        assert s["enabled"] is True
        assert s["wallet"] == "0xDEADBEEF"
        assert s["frequency"] == 1


# ---------------------------------------------------------------------------
# Top-level import
# ---------------------------------------------------------------------------

def test_top_level_import():
    from latent_protocol.adapters import UnifiedAdapter as UA, detect_platform as dp
    assert UA is UnifiedAdapter
    assert dp is detect_platform
