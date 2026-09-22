"""Wallet binding: only Privy-claimable (email) or an existing address — never a local key."""

import httpx
import pytest

from latent_protocol import setup as setup_mod
from latent_protocol import wallet as wallet_api


class _Resp:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


def test_no_local_key_generation_left():
    assert not hasattr(setup_mod, "generate_wallet")


def test_pregenerate_email_posts_to_server(monkeypatch):
    calls = []

    def fake_post(url, json, timeout):
        calls.append((url, json))
        return _Resp(200, {"wallet": "0x" + "a" * 40, "privy_user_id": "did:privy:x", "claim_url": "https://c"})

    monkeypatch.setattr(httpx, "post", fake_post)
    out = wallet_api.pregenerate_email("me@example.com", "https://srv/")
    assert calls == [("https://srv/auth/pregenerate", {"email": "me@example.com"})]
    assert out == {"wallet": "0x" + "a" * 40, "privy_user_id": "did:privy:x", "claim_url": "https://c"}


def test_pregenerate_email_defaults_claim_url(monkeypatch):
    monkeypatch.setattr(
        httpx, "post", lambda *a, **k: _Resp(200, {"wallet": "0x" + "b" * 40, "privy_user_id": "u"})
    )
    assert wallet_api.pregenerate_email("me@example.com", "https://srv")["claim_url"] == wallet_api.DEFAULT_CLAIM_URL


def test_pregenerate_email_surfaces_server_error(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp(429, {"detail": "slow down"}))
    with pytest.raises(ValueError, match="slow down"):
        wallet_api.pregenerate_email("me@example.com", "https://srv")


def test_pregenerate_email_rejects_missing_wallet(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp(200, {}))
    with pytest.raises(ValueError, match="no wallet"):
        wallet_api.pregenerate_email("me@example.com", "https://srv")


def test_pregenerate_email_rejects_bad_email(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: pytest.fail("must not hit the network"))
    with pytest.raises(ValueError, match="invalid email"):
        wallet_api.pregenerate_email("nope", "https://srv")
