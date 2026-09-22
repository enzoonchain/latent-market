"""Latent Protocol — Hermes plugin (flat install, standalone).

Installed by `npx latent-protocol init` into ~/.hermes/plugins/agent-ads/.

Deliberately stdlib-only: Hermes runs from its own venv (often uv-built, with
no pip), so a plugin that imports a pip package fails to load there with
"No module named ...". Everything this plugin needs lives in this one file.
The sanitising / footer helpers mirror ``latent_protocol/sanitize.py`` and
``latent_protocol/footer.py`` — keep them in sync.

Surface: ``transform_llm_output`` only — a visible, labelled "Sponsored"
footer under the finished reply. Hermes applies it before the reply is stored
and delivered, so what is billed is what the user sees. ``pre_llm_call`` is
deliberately NOT used: its return value is appended to the user's message and
reaches only the model, never the user.

The stored reply keeps the footer (the user scrolls back and still sees it),
so an ``llm_request`` middleware strips our footers from the assistant turns
of every outgoing request: the ad is for the reader, never context for the
model — otherwise it starts commenting on "that Sponsored block".
"""

from __future__ import annotations

import json
import os
import re
import secrets
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode, urlsplit

DEFAULT_SERVER = "https://api.latentprotocol.xyz"
DASHBOARD_URL = "https://www.latentprotocol.xyz/dashboard"
REQUEST_TIMEOUT_SEC = 2.0
AGENT = "hermes"
SURFACE = "response_footer"

_CONFIG_DIR = Path.home() / ".latent-protocol"
_CONFIG_FILE = _CONFIG_DIR / "config.json"
_DEVICE_ID_FILE = _CONFIG_DIR / "device_id"
_EVM_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

# ── Ad-copy sanitisation (mirrors latent_protocol/sanitize.py) ─────────────
# Advertiser text is untrusted and lands in a terminal or a chat message.
_ESC_SEQ = re.compile(
    r"\x1b\][\s\S]*?(?:\x07|\x1b\\|$)"
    r"|\x1b\[[0-?]*[ -/]*[@-~]"
    r"|\x1b[ -/]*[0-~]"
    r"|\x1b[@-_]"
)
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_BIDI = re.compile(r"[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]")
_WHITESPACE = re.compile(r"\s+")
_MD_LINK_BRACKETS = str.maketrans({"[": "［", "]": "］"})
AD_LIMITS = {"body": 140, "cta_text": 24}


def sanitize_ad_text(text, max_len: int = 140) -> str:
    s = str(text or "")
    s = _ESC_SEQ.sub("", s)
    s = _CONTROL.sub(" ", s)
    s = _BIDI.sub("", s)
    s = s.translate(_MD_LINK_BRACKETS)
    s = _WHITESPACE.sub(" ", s).strip()
    if max_len > 0 and len(s) > max_len:
        s = s[: max(0, max_len - 1)].rstrip() + "…"
    return s


def is_safe_https_url(url) -> bool:
    if not isinstance(url, str) or not url.startswith("https://"):
        return False
    if _CONTROL.search(url) or _BIDI.search(url):
        return False
    return "@" not in urlsplit(url).netloc


# Every footer style starts with this shape and is always the tail of a reply.
_FOOTER_TAIL = re.compile(r"\n\n(?:---\n)?💰 (?:\*\*|\*)?Sponsored:[\s\S]*\Z")


def strip_footer(text):
    """Remove a trailing sponsored footer from one assistant text."""
    if not isinstance(text, str) or "Sponsored:" not in text:
        return text
    return _FOOTER_TAIL.sub("", text)


def _strip_content(content):
    """(new_content, changed) for a message's ``content`` — str or block list."""
    if isinstance(content, str):
        new = strip_footer(content)
        return new, new != content
    if isinstance(content, list):
        changed, out = False, []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                new = strip_footer(block["text"])
                if new != block["text"]:
                    block, changed = {**block, "text": new}, True
            out.append(block)
        return out, changed
    return content, False


def strip_footers_from_request(request):
    """Copy of an LLM request with our footers removed from assistant turns
    (chat ``messages`` and responses-API ``input``), or None if unchanged."""
    if not isinstance(request, dict):
        return None
    changed_any, new_req = False, dict(request)
    for key in ("messages", "input"):
        items = request.get(key)
        if not isinstance(items, list):
            continue
        out = []
        for item in items:
            if isinstance(item, dict) and item.get("role") == "assistant" and "content" in item:
                content, changed = _strip_content(item["content"])
                if changed:
                    item, changed_any = {**item, "content": content}, True
            out.append(item)
        new_req[key] = out
    return new_req if changed_any else None


def _style_for_platform(platform) -> str:
    p = (platform or "").lower()
    if "telegram" in p:
        return "telegram"
    if any(k in p for k in ("tui", "cli", "term")):
        return "cli"
    return "markdown"


def click_url(ad: dict, cfg: dict) -> str:
    """The link a reader clicks: the server credits the click (signed
    ``click_token``) and 302s to the advertiser's stored URL. Falls back to the
    bare ``cta_url`` when the ad carries no click token."""
    ad_id = ad.get("ad_id") or ad.get("id")
    token = ad.get("click_token")
    if ad_id and token:
        return f"{cfg['server']}/ad/click?" + urlencode({"ad": ad_id, "w": cfg["wallet"], "t": token})
    url = ad.get("cta_url", "")
    return url if is_safe_https_url(url) else ""


def format_footer(ad: dict, style: str = "markdown", link: str = "") -> str:
    body = sanitize_ad_text(ad.get("body") or ad.get("title"), AD_LIMITS["body"]) or "Sponsored"
    cta_text = sanitize_ad_text(ad.get("cta_text"), AD_LIMITS["cta_text"]) or "Learn more"
    safe_url = link if is_safe_https_url(link) else ""
    earn = ad.get("earn_amount", 0)
    if style == "telegram":
        cta_line = f"[{cta_text}]({safe_url})" if safe_url else cta_text
        return f"\n\n💰 *Sponsored:* {body}\n{cta_line}  (+${earn} USDC)"
    if style == "cli":
        cta_line = f"{cta_text} → {safe_url}" if safe_url else cta_text
        return f"\n\n💰 Sponsored: {body}\n  {cta_line}\n  +${earn} USDC earned"
    cta_line = f"[{cta_text} →]({safe_url})" if safe_url else f"{cta_text} →"
    return f"\n\n---\n💰 **Sponsored:** {body}  \n{cta_line}  \n_+${earn} USDC earned_"


# ── Config + device id — the same files every other surface uses ─────────
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


def settings() -> dict | None:
    """Wallet/server/frequency, or None when ads are off or no wallet is set."""
    cfg = load_config()
    env_enabled = os.environ.get("ADS_ENABLED")
    if env_enabled is not None:
        on = env_enabled.lower() not in ("false", "0", "no")
    else:
        on = cfg.get("enabled") is not False
    wallet = os.environ.get("ADS_WALLET") or (cfg.get("wallet") if isinstance(cfg.get("wallet"), str) else "")
    if not on or not wallet:
        return None
    server = os.environ.get("ADS_SERVER") or cfg.get("server") or DEFAULT_SERVER
    try:
        frequency = max(int(cfg.get("frequency", 1)), 1)
    except (TypeError, ValueError):
        frequency = 1
    return {"wallet": wallet, "server": str(server).rstrip("/"), "frequency": frequency}


def device_id() -> str:
    """Stable per-install id shared with the other surfaces. Never raises."""
    try:
        existing = _DEVICE_ID_FILE.read_text().strip()
        if existing:
            return existing
    except OSError:
        pass
    new_id = secrets.token_hex(16)
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        fd = os.open(_DEVICE_ID_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        with os.fdopen(fd, "w") as f:
            f.write(new_id)
        return new_id
    except OSError:
        try:
            return _DEVICE_ID_FILE.read_text().strip() or new_id
        except OSError:
            return new_id


# ── Marketplace calls — fail open, hard timeout ───────────────────────────
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


def fetch_ad(cfg: dict) -> dict | None:
    status, ad = _post_json(
        f"{cfg['server']}/ad/request",
        {
            "user_wallet": cfg["wallet"],
            "agent": AGENT,
            # Category slug only — the conversation never leaves the machine.
            "context": "coding",
            "surface": SURFACE,
            "device_id": device_id(),
        },
    )
    if status != 200 or not isinstance(ad, dict) or not (ad.get("ad_id") or ad.get("id")):
        return None
    return ad


def report_impression(ad: dict, cfg: dict) -> None:
    ad_id = ad.get("ad_id") or ad.get("id")
    if not ad_id:
        return
    _post_json(
        f"{cfg['server']}/ad/impression",
        {"ad_id": ad_id, "user_wallet": cfg["wallet"], "token": ad.get("impression_token", "")},
    )


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
    state = {"responses": 0, "paused": False}

    def transform_llm_output(response_text="", session_id=None, platform=None, **_kwargs):
        if state["paused"] or not response_text:
            return None
        cfg = settings()
        if not cfg:
            return None
        state["responses"] += 1
        if state["responses"] % cfg["frequency"] != 0:
            return None
        ad = fetch_ad(cfg)
        if not ad:
            return None
        footer = format_footer(ad, style=_style_for_platform(platform), link=click_url(ad, cfg))
        # Hermes stores and delivers this return value (turn_final_response:
        # the transform runs before the reply is appended and flushed), so
        # billing here bills exactly what the user is shown.
        report_impression(ad, cfg)
        return response_text + footer

    def strip_history(request=None, **_kwargs):
        cleaned = strip_footers_from_request(request)
        if cleaned is None:
            return None
        return {"request": cleaned, "source": "agent-ads", "reason": "strip sponsored footers from history"}

    ctx.register_hook("transform_llm_output", transform_llm_output)
    register_middleware = getattr(ctx, "register_middleware", None)
    if callable(register_middleware):  # Hermes builds without middleware keep the footer in history
        register_middleware("llm_request", strip_history)
    ctx.register_command(
        "ads",
        lambda args: handle_ads_command(args, state),
        "Sponsored footer: /ads [on|off|settings|balance|setup]",
        args_hint="[on|off|settings|balance|setup]",
    )


def handle_ads_command(args, state: dict) -> str:
    raw = (args or "").strip()
    cmd = raw.lower()
    cfg = load_config()
    wallet = cfg.get("wallet") or ""

    if cmd == "off":
        state["paused"] = True
        return "❌ Sponsored footer paused for this Hermes session. `/ads on` to resume."
    if cmd == "on":
        state["paused"] = False
        return "✅ Sponsored footer on."
    if cmd in ("balance", "payout"):
        # Both need a wallet signature now (S3/S4) — the dashboard does it.
        return f"💰 Balance and cash-out: {DASHBOARD_URL} (sign in with the same login)."
    if cmd == "settings":
        return (
            "⚙️ **Ad Settings**\n"
            f"- Wallet: `{wallet or 'not set'}`\n"
            f"- Footer: {'paused' if state['paused'] else 'on'}\n"
            f"- Frequency: every {cfg.get('frequency', 1)} replies\n"
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
        "- `/ads on` / `/ads off` — resume / pause the sponsored footer\n"
        "- `/ads settings` — wallet, frequency, server\n"
        "- `/ads balance` — balance and cash-out (dashboard)\n"
        "- `/ads setup` — change the earning wallet"
    )


__all__ = ["register"]
