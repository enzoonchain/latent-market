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
from ..sanitize import AD_LIMITS, is_safe_https_url, sanitize_ad_text
from ..tracker import Tracker

_CONFIG_DIR = Path.home() / ".latent-protocol"
_CACHE_FILE = _CONFIG_DIR / "statusline_cache.json"
_CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"

_DEFAULT_ROTATE_SECONDS = 30
_DEFAULT_REFRESH_INTERVAL = 30
# Bill only after the cached line has been on screen this long. The statusLine
# command restarts every refresh; dwell is the cache age, not process time.
_MIN_BILL_SECONDS = 10


# ── Rendering ────────────────────────────────────────────────────────────────

def _is_safe_url(url: str) -> bool:
    """Only https:// targets may become clickable links.

    An ad's cta_url is third-party data. Emitting it verbatim inside an OSC 8
    escape would let a malicious advertiser ship dangerous schemes
    (javascript:, file:, data:, control-char tricks) as a clickable link in the
    user's terminal. Thin wrapper over the shared `sanitize.is_safe_https_url`
    (kept as its own name here since existing tests call `cc._is_safe_url`
    directly) — this used to be its own, slightly looser copy (only rejected
    ESC/BEL, not the full control range) that had already started drifting
    from the shared check.
    """
    return is_safe_https_url(url)


def _osc8_link(text: str, url: str) -> str:
    """OSC 8 terminal hyperlink — clickable in supporting terminals/IDEs.

    Falls back to plain text (no link) when the URL isn't a safe https target.
    """
    if not _is_safe_url(url):
        return text
    return f"\033]8;;{url}\033\\{text}\033]8;;\033\\"


# Past this the bare URL wraps and terminals stop treating it as one link.
_MAX_BARE_URL = 120


def _link_shape() -> str:
    """How to emit a clickable status line for the terminal that is running us.

    ``osc8`` — the text itself is the hyperlink.
    ``plain`` — no OSC 8; append a short URL the terminal can auto-detect and the user can select.
    ``hybrid`` — both, so a terminal that strips OSC 8 still shows a copyable URL.
    """
    if os.environ.get("TMUX"):
        return "plain"
    if os.environ.get("SSH_TTY") or os.environ.get("SSH_CONNECTION"):
        return "hybrid"
    if os.environ.get("KITTY_WINDOW_ID") or os.environ.get("WEZTERM_PANE") or os.environ.get("ITERM_SESSION_ID"):
        return "osc8"
    if os.environ.get("ALACRITTY_SOCKET") or os.environ.get("ALACRITTY_WINDOW_ID"):
        return "plain"
    term = os.environ.get("TERM_PROGRAM") or ""
    if term in ("vscode", "iTerm.app", "WezTerm"):
        return "osc8"
    if term in ("Apple_Terminal", "WarpTerminal"):
        return "plain"
    if os.environ.get("WT_SESSION"):
        return "osc8"
    return "plain" if sys.platform == "win32" else "hybrid"


def format_statusline(ad: dict) -> str:
    """Single-line sponsored status line (ANSI). No trailing newline.

    ``body``/``title``/``cta_text`` are advertiser-controlled and are about to
    be written straight into the user's real terminal — sanitize before any
    ANSI is built around them (raw ESC/CSI/OSC or bidi-override bytes here
    would act on the terminal itself, not just render as text).
    """
    body = sanitize_ad_text(ad.get("body") or ad.get("title"), AD_LIMITS["body"]) or "Sponsored"
    cta_url = ad.get("cta_url", "") if isinstance(ad.get("cta_url"), str) else ""
    earn = ad.get("earn_amount", 0)
    label = f"ad· {body}"
    bare = f"  {cta_url}" if _is_safe_url(cta_url) and len(cta_url) <= _MAX_BARE_URL else ""
    shape = _link_shape()
    if not _is_safe_url(cta_url):
        linked = label
    elif shape == "osc8":
        linked = _osc8_link(label, cta_url)
    elif shape == "plain":
        linked = label + bare
    else:
        linked = _osc8_link(label, cta_url) + bare
    return f"{linked}  \033[2m· Sponsored: +${earn} USDC\033[0m"


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


def _bill_cached(cache: dict, now: float, config: Config) -> None:
    """Credit the cached ad once it has been shown for ``_MIN_BILL_SECONDS``."""
    ad = cache.get("ad")
    if not ad or cache.get("billed"):
        return
    elapsed = now - float(cache.get("fetched_at") or 0)
    if elapsed < _MIN_BILL_SECONDS:
        return
    from ..delivery import confirm_display

    confirm_display(
        Tracker(config.server),
        ad,
        config.wallet,
        displayed_ms=int(elapsed * 1000),
    )
    cache["billed"] = True
    _save_cache(cache)


def render(session: dict | None = None) -> str:
    """Return the status-line string to print, or '' to show nothing.

    Rotates ads on disk so impressions are billed once per rotation window, not
    once per refresh, and only after the line has been on screen for 10s.
    Fails open: any error returns ''.
    """
    session = session or {}
    config = Config.from_env()
    if not config.enabled or not config.wallet:
        return ""

    session_id = str(session.get("session_id", "") or "")
    now = time.time()
    cache = _load_cache()
    _bill_cached(cache, now, config)

    fresh = (
        cache.get("ad")
        and (now - cache.get("fetched_at", 0)) < _rotate_seconds()
        and cache.get("session_id", session_id) == session_id
    )
    if fresh:
        return format_statusline(cache["ad"])

    from ..delivery import reserve_ad

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
    # Shown now; billed on a later refresh once dwell clears 10s.
    _save_cache({"ad": ad, "fetched_at": now, "session_id": session_id, "billed": False})
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
