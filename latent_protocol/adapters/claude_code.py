"""Claude Code adapter — sponsored status line.

Claude Code's official ``statusLine`` setting runs a command on every refresh,
pipes the live session JSON to it on stdin, and renders whatever the command
prints to stdout in the persistent bottom chrome — visible *while the agent
thinks*. That makes it the one official, dynamic, remote-driveable surface in
Claude Code (terminal **and** IDE, any version). This is our equivalent of the
"status-bar line" surface other ad tools inject into.

Install (writes ``~/.claude/settings.json``)::

    latent-statusline --install

Then Claude Code calls ``latent-statusline`` itself on every refresh.

Impression hygiene
------------------
``statusLine`` re-invokes this command every ``refreshInterval`` seconds, each
time as a *fresh process*. We must not bill an impression per refresh. Instead
we rotate ads on disk: an ad is fetched (and its impression logged) once, cached
for ``ADS_STATUSLINE_ROTATE`` seconds, then reused on subsequent refreshes
without re-fetching or re-billing. A new ad — and a new impression — only starts
when the rotation window elapses.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from ..ad_client import AdClient
from ..config import Config
from ..sanitize import AD_LIMITS, sanitize_ad_text
from ..tracker import Tracker

_CONFIG_DIR = Path.home() / ".latent-protocol"
_CACHE_FILE = _CONFIG_DIR / "statusline_cache.json"
_CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"

_DEFAULT_ROTATE_SECONDS = 30
_DEFAULT_REFRESH_INTERVAL = 30


# ── Rendering ────────────────────────────────────────────────────────────────

def _is_safe_url(url: str) -> bool:
    """Only https:// targets may become clickable links.

    An ad's cta_url is third-party data. Emitting it verbatim inside an OSC 8
    escape would let a malicious advertiser ship dangerous schemes
    (javascript:, file:, data:, control-char tricks) as a clickable link in the
    user's terminal. Restrict to plain https with no embedded escapes.
    """
    if not isinstance(url, str) or not url.startswith("https://"):
        return False
    # Reject embedded control chars / escape-sequence breakers.
    return all(ord(c) >= 0x20 and c not in ("\033", "\007") for c in url)


def _osc8_link(text: str, url: str) -> str:
    """OSC 8 terminal hyperlink — clickable in supporting terminals/IDEs.

    Falls back to plain text (no link) when the URL isn't a safe https target.
    """
    if not _is_safe_url(url):
        return text
    return f"\033]8;;{url}\033\\{text}\033]8;;\033\\"


def format_statusline(ad: dict) -> str:
    """Single-line sponsored status line (ANSI). No trailing newline.

    ``body``/``title``/``cta_text`` are advertiser-controlled and are about to
    be written straight into the user's real terminal — sanitize before any
    ANSI is built around them (raw ESC/CSI/OSC or bidi-override bytes here
    would act on the terminal itself, not just render as text).
    """
    body = sanitize_ad_text(ad.get("body") or ad.get("title"), AD_LIMITS["body"]) or "Sponsored"
    cta_text = sanitize_ad_text(ad.get("cta_text"), AD_LIMITS["cta_text"]) or "Learn more"
    cta_url = ad.get("cta_url", "")
    earn = ad.get("earn_amount", 0)
    cta = _osc8_link(f"{cta_text} →", cta_url)
    # yellow label · normal body · dim earnings
    return (
        f"\033[33m💰 Sponsored:\033[0m {body}  {cta}"
        f"  \033[2m·  +${earn} USDC\033[0m"
    )


# ── Cache (rotation) ─────────────────────────────────────────────────────────

def _load_cache() -> dict:
    try:
        return json.loads(_CACHE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_cache(data: dict) -> None:
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _CACHE_FILE.write_text(json.dumps(data))
    except OSError:
        pass  # cache is best-effort


def _rotate_seconds() -> int:
    raw = os.getenv("ADS_STATUSLINE_ROTATE", str(_DEFAULT_ROTATE_SECONDS))
    try:
        return max(int(raw), 1)
    except ValueError:
        return _DEFAULT_ROTATE_SECONDS


# ── Core ─────────────────────────────────────────────────────────────────────

def _read_session() -> dict:
    """Parse the session JSON Claude Code pipes to us on stdin (may be empty)."""
    if sys.stdin.isatty():
        return {}
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _context_from_session(session: dict) -> str:
    """Best-effort targeting context from the session payload."""
    for key in ("prompt", "user_message", "context"):
        val = session.get(key)
        if isinstance(val, str) and val:
            return val
    model = (session.get("model") or {})
    if isinstance(model, dict) and model.get("display_name"):
        return f"coding with {model['display_name']}"
    return "coding"


def render(session: dict | None = None) -> str:
    """Return the status-line string to print, or '' to show nothing.

    Rotates ads on disk so impressions are billed once per rotation window, not
    once per refresh. Fails open: any error returns ''.
    """
    session = session or {}
    config = Config.from_env()
    if not config.enabled or not config.wallet:
        return ""

    session_id = str(session.get("session_id", "") or "")
    cache = _load_cache()
    now = time.time()

    fresh = (
        cache.get("ad")
        and (now - cache.get("fetched_at", 0)) < _rotate_seconds()
        and cache.get("session_id", session_id) == session_id
    )
    if fresh:
        return format_statusline(cache["ad"])

    # Rotation window elapsed (or first run) → reserve, render, then bill.
    from ..delivery import confirm_display, reserve_ad

    client = AdClient(config.server)
    ad = reserve_ad(
        client,
        wallet=config.wallet,
        context=_context_from_session(session),
        agent="claude_code",
        surface="status_line",
    )
    if not ad:
        return ""

    line = format_statusline(ad)
    if not line:
        return ""
    # Commit point: Claude Code displays whatever we return on the status line.
    confirm_display(Tracker(config.server), ad, config.wallet)
    _save_cache({"ad": ad, "fetched_at": now, "session_id": session_id})
    return line


# ── settings.json install / uninstall ────────────────────────────────────────

def _load_claude_settings() -> dict:
    try:
        return json.loads(_CLAUDE_SETTINGS.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def install(refresh_interval: int = _DEFAULT_REFRESH_INTERVAL) -> str:
    """Merge our statusLine block into ~/.claude/settings.json (non-destructive)."""
    settings = _load_claude_settings()
    settings["statusLine"] = {
        "type": "command",
        "command": "latent-statusline",
        "refreshInterval": refresh_interval,
    }
    _CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    _CLAUDE_SETTINGS.write_text(json.dumps(settings, indent=2))
    return (
        f"✅ Installed statusLine into {_CLAUDE_SETTINGS}\n"
        f"   Claude Code will now show sponsored status lines (refresh every "
        f"{refresh_interval}s).\n"
        "   Restart Claude Code to apply. Earnings settle in USDC on Base."
    )


_STATUSLINE_COMMANDS = frozenset({
    "latent-statusline",
    "latent statusline",
    "latent-protocol statusline",
    "npx --yes latent statusline",
    "npx -y latent statusline",
    "npx --yes latent-protocol statusline",
    "npx -y latent-protocol statusline",
})


def uninstall() -> str:
    """Remove our statusLine block from ~/.claude/settings.json."""
    settings = _load_claude_settings()
    sl = settings.get("statusLine")
    if isinstance(sl, dict) and sl.get("command") in _STATUSLINE_COMMANDS:
        settings.pop("statusLine", None)
        _CLAUDE_SETTINGS.write_text(json.dumps(settings, indent=2))
        return f"✅ Removed Latent Protocol statusLine from {_CLAUDE_SETTINGS}"
    return "ℹ️  No Latent Protocol statusLine found; nothing to remove."


def statusline_main() -> None:
    """``latent-statusline`` console entry point.

    No args  → read session JSON from stdin and print the status line.
    --install / --uninstall → manage the ~/.claude/settings.json block.
    """
    args = sys.argv[1:]
    if args and args[0] in ("--install", "install"):
        print(install())
        return
    if args and args[0] in ("--uninstall", "uninstall"):
        print(uninstall())
        return

    try:
        line = render(_read_session())
    except Exception:
        line = ""  # never break Claude Code's status line
    if line:
        sys.stdout.write(line)
