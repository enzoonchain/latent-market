"""Latent Protocol — Hermes plugin (flat install, standalone).

Installed by `npx latent-protocol init` into ~/.hermes/plugins/agent-ads/.

Deliberately stdlib-only: Hermes runs from its own venv (often uv-built, with
no pip), so a plugin that imports a pip package fails to load there with
"No module named ...".

This Python side registers no LLM hooks: it never touches a request to the
model or the model's reply (no ``pre_llm_call``, ``transform_llm_output`` or
``llm_request`` middleware). The only ad surface is the Hermes Desktop status
bar, served by ``desktop/plugin.js`` in this same folder. Here we only add the
``/ads`` command (wallet setup, settings, dashboard link).
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_SERVER = "https://api.latentprotocol.xyz"
DASHBOARD_URL = "https://www.latentprotocol.xyz/dashboard"
REQUEST_TIMEOUT_SEC = 2.0

_CONFIG_DIR = Path.home() / ".latent-protocol"
_CONFIG_FILE = _CONFIG_DIR / "config.json"
_EVM_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def load_config() -> dict:
    try:
        data = json.loads(_CONFIG_FILE.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(update: dict) -> None:
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    data = load_config()
    data.update(update)
    _CONFIG_FILE.write_text(json.dumps(data, indent=2))


def _post_json(url: str, body: dict):
    """(status, parsed-json-or-None); (0, None) on any network error."""
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"null")
        except ValueError:
            return exc.code, None
    except (urllib.error.URLError, OSError, ValueError):
        return 0, None
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, None


def pregenerate_email(email: str, server: str) -> dict:
    if "@" not in email:
        raise ValueError("invalid email")
    status, body = _post_json(f"{server.rstrip('/')}/auth/pregenerate", {"email": email})
    if status != 200 or not isinstance(body, dict):
        detail = body.get("detail") if isinstance(body, dict) else None
        raise ValueError(detail if isinstance(detail, str) else f"pregenerate HTTP {status or 'error'}")
    if not body.get("wallet") or not body.get("privy_user_id"):
        raise ValueError("pregenerate returned no wallet")
    return body


# ── Hermes entry point ────────────────────────────────────────────────────
def register(ctx) -> None:
    ctx.register_command(
        "ads",
        handle_ads_command,
        "Latent Protocol: /ads [settings|balance|setup]",
        args_hint="[settings|balance|setup]",
    )


def handle_ads_command(args) -> str:
    raw = (args or "").strip()
    cmd = raw.lower()
    cfg = load_config()
    wallet = cfg.get("wallet") or ""

    if cmd in ("balance", "payout"):
        # Both need a wallet signature now (S3/S4) — the dashboard does it.
        return f"💰 Balance and cash-out: {DASHBOARD_URL} (sign in with the same login)."
    if cmd == "settings":
        return (
            "⚙️ **Ad Settings**\n"
            f"- Wallet: `{wallet or 'not set'}`\n"
            f"- Server: {cfg.get('server') or DEFAULT_SERVER}"
        )
    if cmd.startswith("setup use "):
        addr = raw[len("setup use "):].strip()
        if not _EVM_RE.match(addr):
            return "❌ Invalid address. Must be `0x` followed by 40 hex characters."
        save_config({"wallet": addr, "auth": "address"})
        return f"✅ Wallet set to `{addr}`."
    if cmd.startswith("setup email "):
        email = raw[len("setup email "):].strip()
        try:
            earner = pregenerate_email(email, cfg.get("server") or DEFAULT_SERVER)
        except ValueError as exc:
            return f"❌ {exc}"
        save_config({"wallet": earner["wallet"], "privy_user_id": earner["privy_user_id"], "auth": "privy"})
        claim = earner.get("claim_url") or "https://www.latentprotocol.xyz/authorize"
        return f"✅ Wallet ready for {email}: `{earner['wallet']}`\nClaim it with an email code at {claim}."
    if cmd.startswith("setup"):
        return (
            "🔧 **Wallet Setup**\n\n"
            f"Current wallet: {f'`{wallet}`' if wallet else 'not set'}\n\n"
            "- `npx latent-protocol init` — sign in via auth link (email / Google / X / wallet)\n"
            "- `/ads setup email you@domain` — get a wallet you claim with your email\n"
            "- `/ads setup use 0x...` — use an existing address"
        )
    return (
        "**Ads Commands:**\n"
        "- `/ads settings` — wallet and server\n"
        "- `/ads balance` — balance and cash-out (dashboard)\n"
        "- `/ads setup` — change the earning wallet"
    )


__all__ = ["register"]
