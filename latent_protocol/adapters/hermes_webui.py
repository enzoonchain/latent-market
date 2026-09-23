"""Hermes WebUI patch — injects a sponsored ad into the chat UI.

Hermes WebUI ([nesquena/hermes-webui](https://github.com/nesquena/hermes-webui))
runs its own agent loop and does **not** load Hermes CLI plugins, so the
`agent-ads` footer never appears there. This module patches WebUI's
``static/index.html`` with a small MutationObserver that:

1. Reserves an ad when a thinking row goes active
2. Shows a temporary banner in the thinking row
3. Persists a footer on the assistant turn when the response settles
4. Bills ``/ad/impression`` only after the creative is in the DOM

Usage:
    latent-hermes-patch               # patch (reads ADS_* env vars / config)
    latent-hermes-patch --undo        # remove the patch
    latent-hermes-patch --wallet 0x…  # explicit wallet
    latent-hermes-patch --server …    # explicit server URL

The patch survives hermes-webui *config* changes but not package *upgrades*
or git pulls that overwrite ``index.html``. Re-run after upgrading.
"""

from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path

_MARKER = "<!-- latent-protocol-webui-patch -->"

# ── injected JavaScript ──────────────────────────────────────────────────────

_AD_JS = r"""(function () {
  'use strict';

  var SERVER   = __SERVER__;
  var WALLET   = __WALLET__ || localStorage.getItem('latent_wallet') || '';
  var FREQ     = __FREQ__;
  var _turns   = 0;
  var _pending = null;   // reserved ad for current turn
  var _busy    = false;
  var _banner  = null;

  if (!WALLET) {
    console.warn('[latent-protocol] no wallet — WebUI ads disabled');
    return;
  }

  function _post(path, body) {
    return fetch(SERVER + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit'
    }).then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // Classify locally — mirrors latent_protocol/classify.py's category slugs
  // and keyword table. Only the resulting slug is ever sent as `context`;
  // the raw chat text this reads from the DOM (see _ctx below) never leaves
  // the browser. This is the same privacy invariant every other adapter in
  // this package already keeps.
  var _KEYWORDS = {
    'frontend-ui': ['react', 'vue', 'svelte', 'angular', 'next', 'nuxt', 'tailwind', 'css', 'component', 'frontend', 'ui', 'ux', 'webpack', 'vite', 'dom', 'jsx', 'tsx'],
    'backend': ['api', 'server', 'express', 'fastapi', 'flask', 'django', 'rails', 'spring', 'endpoint', 'rest', 'graphql', 'grpc', 'middleware', 'auth', 'jwt', 'route'],
    'databases': ['sql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'mongo', 'redis', 'prisma', 'query', 'schema', 'migration', 'index', 'orm', 'database'],
    'devops-infra': ['docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'ci', 'cd', 'pipeline', 'deploy', 'nginx', 'aws', 'gcp', 'azure', 'helm', 'infra', 'devops', 'compose'],
    'ai-ml': ['llm', 'gpt', 'openai', 'anthropic', 'claude', 'embedding', 'vector', 'rag', 'pytorch', 'tensorflow', 'model', 'training', 'inference', 'prompt', 'agent', 'ml'],
    'web3-crypto': ['solidity', 'ethereum', 'evm', 'wallet', 'web3', 'onchain', 'contract', 'erc20', 'erc721', 'base', 'usdc', 'x402', 'defi', 'token', 'crypto', 'blockchain'],
    'mobile': ['swift', 'swiftui', 'kotlin', 'android', 'ios', 'flutter', 'dart', 'react-native', 'expo', 'xcode', 'mobile'],
    'data-eng': ['pandas', 'spark', 'airflow', 'etl', 'dbt', 'kafka', 'snowflake', 'bigquery', 'warehouse', 'dataframe', 'parquet', 'pipeline', 'analytics']
  };

  function _classify(text) {
    var lower = String(text || '').toLowerCase();
    var best = 'general', bestScore = 0;
    for (var cat in _KEYWORDS) {
      var words = _KEYWORDS[cat];
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var re = new RegExp('(?:^|[^a-z0-9])' + w + '(?=[^a-z0-9]|$)', 'g');
        var m = lower.match(re);
        if (m) score += m.length;
      }
      if (score > bestScore) { best = cat; bestScore = score; }
    }
    return best;
  }

  function _fetchAd(ctx) {
    return _post('/ad/request', {
      user_wallet: WALLET,
      agent: 'hermes',
      context: _classify(ctx),
      surface: 'webui_thinking',
      tags: []
    });
  }

  function _logImpression(ad) {
    if (!ad) return;
    var id = ad.ad_id || ad.id || '';
    if (!id) return;
    _post('/ad/impression', {
      ad_id: id,
      user_wallet: WALLET,
      token: ad.impression_token || ''
    });
  }

  function _ctx() {
    var nodes = document.querySelectorAll(
      '.msg-row[data-role="user"] .msg-body, .user-turn .msg-body, .user-segment .msg-body'
    );
    var last = nodes.length ? nodes[nodes.length - 1] : null;
    return last && last.textContent ? last.textContent : 'thinking';
  }

  function _thinkingEl() {
    return document.querySelector(
      '.agent-activity-thinking[data-thinking-active="1"],' +
      '.agent-activity-thinking[data-live-thinking="1"]'
    );
  }

  function _latestAssistantHost() {
    var turns = document.querySelectorAll(
      '.assistant-turn, .msg-row[data-role="assistant"], .assistant-segment'
    );
    for (var i = turns.length - 1; i >= 0; i--) {
      var t = turns[i];
      if (t.querySelector && t.querySelector('.latent-ad-footer')) continue;
      // Prefer a settled message body host over a bare shell
      var body = t.querySelector('.msg-body');
      if (body || t.classList.contains('assistant-segment') || t.classList.contains('assistant-turn')) {
        return t;
      }
    }
    return null;
  }

  // ad.body/title/cta_text/cta_url are advertiser-controlled and were being
  // concatenated straight into innerHTML with no escaping at all — a
  // <script>/onerror= payload in an ad ran in the user's own browser
  // session. _esc() is a standard textContent-based HTML escape; cta_url is
  // additionally gated to plain https with no embedded control chars (same
  // shape as sanitize.py's is_safe_https_url) before it's ever allowed to
  // become a clickable href.
  function _esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function _isSafeUrl(u) {
    if (typeof u !== 'string' || u.slice(0, 8) !== 'https://') return false;
    for (var i = 0; i < u.length; i++) {
      var c = u.charCodeAt(i);
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
    }
    return true;
  }

  function _adHtml(ad, persistent) {
    var earn = ad.earn_amount
      ? ' · +$' + _esc(parseFloat(ad.earn_amount).toFixed(4)) + ' USDC'
      : '';
    var cta = (ad.cta_url && _isSafeUrl(ad.cta_url))
      ? '<a href="' + _esc(ad.cta_url) + '" target="_blank" rel="noopener noreferrer" '
        + 'style="color:inherit;text-decoration:underline;white-space:nowrap">'
        + _esc(ad.cta_text || 'Learn more') + ' →</a>'
      : '';
    // Quiet trailing tag, not a leading banner label.
    return '<span style="flex:1">' + _esc(ad.body || ad.title || '') + '</span>'
      + cta
      + '<span style="font-size:10px;opacity:.6;flex-shrink:0">Sponsored' + earn + '</span>';
  }

  function _styleBox() {
    return 'margin:6px 0;padding:6px 10px;border:1px solid rgba(127,127,127,.25);'
      + 'border-radius:8px;font-size:12px;'
      + 'display:flex;align-items:center;gap:8px;opacity:.92;line-height:1.4;'
      + 'max-width:var(--msg-max, 720px);margin-left:var(--msg-rail, 0)';
  }

  function _renderThinkingBanner(ad, container) {
    if (!ad || !container) return;
    if (container.querySelector('.latent-ad')) return;
    var el = document.createElement('div');
    el.className = 'latent-ad';
    el.style.cssText = _styleBox();
    el.innerHTML = _adHtml(ad, false);
    container.appendChild(el);
    _banner = el;
  }

  function _persistFooter(ad) {
    if (!ad) return false;
    var host = _latestAssistantHost();
    if (!host) return false;
    if (host.querySelector('.latent-ad-footer')) return true;
    // Skip if plugin/stream already put Sponsored in the message text
    var text = host.textContent || '';
    if (text.indexOf('Sponsored:') !== -1) {
      return true;
    }
    var el = document.createElement('div');
    el.className = 'latent-ad-footer';
    el.setAttribute('data-latent-ad', ad.ad_id || ad.id || '');
    el.style.cssText = _styleBox();
    el.innerHTML = _adHtml(ad, true);
    var foot = host.querySelector('.msg-foot');
    if (foot && foot.parentNode) {
      foot.parentNode.insertBefore(el, foot);
    } else {
      host.appendChild(el);
    }
    _logImpression(ad);
    return true;
  }

  function _clearBanner() {
    if (_banner) { _banner.remove(); _banner = null; }
  }

  function _onThinkingStart() {
    if (_busy) return;
    _turns++;
    if ((_turns - 1) % FREQ !== 0) return;
    _busy = true;
    _pending = null;
    _fetchAd(_ctx()).then(function (ad) {
      _busy = false;
      if (!ad) return;
      _pending = ad;
      var el = _thinkingEl();
      if (el) _renderThinkingBanner(ad, el);
    });
  }

  function _onThinkingEnd() {
    _clearBanner();
    if (_pending) {
      var ad = _pending;
      _pending = null;
      // Retry a few times — assistant DOM may settle after thinking clears
      var tries = 0;
      (function attempt() {
        if (_persistFooter(ad)) return;
        tries++;
        if (tries < 8) setTimeout(attempt, 250);
      })();
    }
  }

  var _wasThinking = false;
  var obs = new MutationObserver(function () {
    var el = _thinkingEl();
    var active = !!el;
    if (active && !_wasThinking) {
      _onThinkingStart();
    } else if (!active && _wasThinking) {
      _onThinkingEnd();
    } else if (active && _pending && el && !el.querySelector('.latent-ad')) {
      _renderThinkingBanner(_pending, el);
    }
    _wasThinking = active;
  });

  function _start() {
    obs.observe(document.body, {
      childList: true, subtree: true,
      attributes: true,
      attributeFilter: ['data-thinking-active', 'data-live-thinking']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start);
  } else {
    _start();
  }
})();
"""


# ── helpers ──────────────────────────────────────────────────────────────────

_WEBUI_MARKERS = (
    "hermes-webui",
    "__HERMES_WEBUI_BUNDLE_VERSION__",
    "hermes-theme",
    "latent-protocol-webui-patch",
)


def _looks_like_webui_static(static: Path) -> bool:
    index = static / "index.html"
    if not index.is_file():
        return False
    try:
        html = index.read_text(encoding="utf-8", errors="ignore")
        if any(m in html for m in _WEBUI_MARKERS):
            return True
    except Exception:
        return False
    parent = static.parent
    return (static / "ui.js").is_file() and (
        (parent / "server.py").is_file()
        or (parent / "bootstrap.py").is_file()
        or (parent / "ctl.sh").is_file()
    )


def _cached_static_from_config() -> Path | None:
    try:
        from ..config import Config

        cfg_path = Path.home() / ".latent-protocol" / "config.json"
        if not cfg_path.is_file():
            return None
        import json

        data = json.loads(cfg_path.read_text(encoding="utf-8"))
        raw = data.get("hermes_webui_static")
        if isinstance(raw, str) and raw:
            p = Path(raw)
            if _looks_like_webui_static(p):
                return p.resolve()
    except Exception:
        pass
    return None


def _persist_static(static: Path) -> None:
    try:
        import json

        cfg_path = Path.home() / ".latent-protocol" / "config.json"
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        data: dict = {}
        if cfg_path.is_file():
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
        data["hermes_webui_static"] = str(static)
        cfg_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass


def _candidate_static_dirs() -> list[Path]:
    """Ordered list of places hermes-webui static/ might live."""
    home = Path.home()
    env_root = os.environ.get("HERMES_WEBUI_ROOT") or os.environ.get("HERMES_WEBUI_DIR")
    env_static = os.environ.get("HERMES_WEBUI_STATIC")
    out: list[Path] = []

    # Explicit env wins over cached path from a previous machine/run.
    if env_static:
        out.append(Path(env_static))
    if env_root:
        out.append(Path(env_root) / "static")
    cached = _cached_static_from_config()
    if cached:
        out.append(cached)

    # pip / importlib — modern hermes-webui ships packages=["api","static"]
    for mod_name in ("hermes_webui",):
        try:
            spec = importlib.util.find_spec(mod_name)
            if spec and spec.origin:
                out.append(Path(spec.origin).parent / "static")
        except Exception:
            pass

    try:
        out_pip = subprocess.run(
            [sys.executable, "-m", "pip", "show", "hermes-webui"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        for line in out_pip.splitlines():
            if line.startswith("Location:"):
                loc = Path(line.split(":", 1)[1].strip())
                out.extend([
                    loc / "hermes_webui" / "static",
                    loc / "static",
                    loc / "hermes_webui_static",
                ])
            if line.startswith("Editable project location:"):
                root = Path(line.split(":", 1)[1].strip())
                out.append(root / "static")
    except Exception:
        pass

    # Running process cwd (pid files + pgrep)
    for pid_file in (
        Path.home() / ".hermes" / "webui.pid",
        Path("/var/run/hermes-webui.pid"),
        Path("/tmp/hermes-webui.pid"),
    ):
        try:
            pid = pid_file.read_text(encoding="utf-8").strip().split()[0]
            cwd = Path(f"/proc/{pid}/cwd").resolve()
            out.append(cwd / "static")
        except Exception:
            pass
    try:
        pg = subprocess.run(
            ["bash", "-lc", "pgrep -af 'hermes-webui|bootstrap\\.py|ctl\\.sh' || true"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in pg.splitlines():
            parts = line.split(None, 1)
            if not parts:
                continue
            try:
                cwd = Path(f"/proc/{parts[0]}/cwd").resolve()
                out.append(cwd / "static")
            except Exception:
                pass
    except Exception:
        pass

    # Common clone / install locations
    out.extend([
        home / "hermes-webui" / "static",
        home / "src" / "hermes-webui" / "static",
        home / "apps" / "hermes-webui" / "static",
        home / "code" / "hermes-webui" / "static",
        home / "git" / "hermes-webui" / "static",
        home / "repos" / "hermes-webui" / "static",
        home / "projects" / "hermes-webui" / "static",
        home / "workspace" / "hermes-webui" / "static",
        home / "dev" / "hermes-webui" / "static",
        Path("/root/hermes-webui") / "static",
        Path("/root/src/hermes-webui") / "static",
        Path("/root/apps/hermes-webui") / "static",
        Path("/opt/hermes-webui") / "static",
        Path("/opt/hermes") / "webui" / "static",
        Path("/opt/hermes/hermes-webui") / "static",
        Path("/srv/hermes-webui") / "static",
        Path("/var/www/hermes-webui") / "static",
        Path("/usr/local/lib/hermes-webui") / "static",
        home / ".hermes" / "hermes-webui" / "static",
        home / ".hermes" / "webui" / "static",
        Path.cwd() / "static",
        Path.cwd() / "hermes-webui" / "static",
    ])

    # Shallow scans
    for base in (home, Path("/root"), Path("/opt"), Path("/srv")):
        try:
            if not base.is_dir():
                continue
            for ent in base.iterdir():
                if not ent.is_dir() or ent.name.startswith("."):
                    continue
                out.append(ent / "hermes-webui" / "static")
                if "hermes-webui" in ent.name.lower():
                    out.append(ent / "static")
        except Exception:
            pass

    return out


def _find_via_filesystem() -> Path | None:
    """Bounded find across common roots for hermes-webui static/index.html."""
    roots = [str(Path.home()), "/root", "/home", "/opt", "/srv", "/var/www", "/usr/local"]
    for root in roots:
        if not Path(root).is_dir():
            continue
        try:
            proc = subprocess.run(
                [
                    "find", root, "-maxdepth", "6", "-type", "f",
                    "(", "-path", "*/hermes-webui/static/index.html",
                    "-o", "-path", "*/hermes_webui/static/index.html", ")",
                ],
                capture_output=True, text=True, timeout=12,
            )
            for line in proc.stdout.splitlines():
                p = Path(line.strip()).parent
                if _looks_like_webui_static(p):
                    return p.resolve()
        except Exception:
            continue

    # Content signature fallback (slower)
    for root in (str(Path.home()), "/root", "/opt"):
        if not Path(root).is_dir():
            continue
        try:
            proc = subprocess.run(
                [
                    "bash", "-lc",
                    f'find {root!s} -maxdepth 5 -type f -name index.html 2>/dev/null | head -80 '
                    f'| while read -r f; do '
                    f'grep -qlE "hermes-webui|__HERMES_WEBUI_BUNDLE_VERSION__|hermes-theme" "$f" '
                    f'&& echo "$f"; done',
                ],
                capture_output=True, text=True, timeout=15,
            )
            for line in proc.stdout.splitlines():
                p = Path(line.strip()).parent
                if _looks_like_webui_static(p):
                    return p.resolve()
        except Exception:
            continue
    return None


def _find_static() -> Path | None:
    """Return hermes-webui's static/ dir, or None if not found."""
    seen: set[Path] = set()
    for p in _candidate_static_dirs():
        try:
            rp = p.resolve()
        except Exception:
            rp = p
        if rp in seen:
            continue
        seen.add(rp)
        if _looks_like_webui_static(rp):
            _persist_static(rp)
            return rp

    found = _find_via_filesystem()
    if found:
        _persist_static(found)
    return found


def _build_script(server: str, wallet: str, frequency: int) -> str:
    import json

    from ..setup import is_valid_address

    if wallet and not is_valid_address(wallet):
        raise ValueError(f"invalid wallet address: {wallet!r}")

    # JSON-encode (not naive string substitution) so a malformed/malicious
    # server URL or wallet can never break out of the JS string literal and
    # inject script into every user's index.html.
    js = (
        _AD_JS.replace("__SERVER__", json.dumps(server.rstrip("/")))
        .replace("__WALLET__", json.dumps(wallet))
        .replace("__FREQ__", str(int(frequency)))
    )
    return f"\n{_MARKER}\n<script>\n{js}</script>\n"


# ── public API ───────────────────────────────────────────────────────────────

def patch(
    server: str,
    wallet: str,
    frequency: int = 1,
    static_dir: Path | None = None,
    *,
    force: bool = True,
) -> str:
    """Inject the ad banner script into hermes-webui's index.html."""
    static = static_dir or _find_static()
    if not static:
        raise RuntimeError(
            "hermes-webui static/ not found.\n"
            "Clone https://github.com/nesquena/hermes-webui and either:\n"
            "  • run this from that repo, or\n"
            "  • pass --static-dir /path/to/hermes-webui/static, or\n"
            "  • set HERMES_WEBUI_ROOT=/path/to/hermes-webui"
        )

    index = static / "index.html"
    if not index.exists():
        raise RuntimeError(f"index.html not found at {index}")

    html = index.read_text(encoding="utf-8")
    if _MARKER in html:
        if not force:
            return f"Already patched: {index}\nRun with --undo first to re-patch."
        html = re.sub(
            r"\n?" + re.escape(_MARKER) + r"\n<script>\n.*?</script>\n?",
            "",
            html,
            flags=re.DOTALL,
        )

    block = _build_script(server, wallet, frequency)
    html = html.replace("</body>", block + "</body>") if "</body>" in html else html + block
    index.write_text(html, encoding="utf-8")
    return f"Patched: {index}"


def unpatch(static_dir: Path | None = None) -> str:
    """Remove the ad banner script from hermes-webui's index.html."""
    static = static_dir or _find_static()
    if not static:
        raise RuntimeError("hermes-webui static/ not found.")

    index = static / "index.html"
    if not index.exists():
        raise RuntimeError(f"index.html not found at {index}")

    html = index.read_text(encoding="utf-8")
    if _MARKER not in html:
        return "Not patched — nothing to remove."

    html = re.sub(
        r"\n?" + re.escape(_MARKER) + r"\n<script>\n.*?</script>\n?",
        "",
        html,
        flags=re.DOTALL,
    )
    index.write_text(html, encoding="utf-8")
    return f"Unpatched: {index}"


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> None:
    """Entry point for `latent-hermes-patch`."""
    import argparse
    from ..config import Config

    p = argparse.ArgumentParser(
        description="Patch hermes-webui to show sponsored ads (thinking + response footer)."
    )
    p.add_argument("--undo", action="store_true", help="Remove the patch")
    p.add_argument("--server", default=None, help="Ad server base URL")
    p.add_argument("--wallet", default=None, help="Base wallet address (0x…)")
    p.add_argument(
        "--frequency",
        type=int,
        default=None,
        help="Show ad every N agent turns (default: 1)",
    )
    p.add_argument(
        "--static-dir",
        default=None,
        help="Path to hermes-webui static/ (auto-detected if omitted)",
    )
    p.add_argument(
        "--no-force",
        action="store_true",
        help="Do not replace an existing patch",
    )
    args = p.parse_args()

    static = Path(args.static_dir) if args.static_dir else None

    if args.undo:
        print(unpatch(static))
        return

    cfg = Config.from_env()
    server = args.server or cfg.server
    wallet = args.wallet or cfg.wallet or ""
    freq = args.frequency or cfg.frequency or 1

    if not wallet:
        print(
            "Warning: no wallet set — ads shown but earnings not credited.\n"
            "Set ADS_WALLET env var or pass --wallet 0x…"
        )

    print(
        patch(
            server=server,
            wallet=wallet,
            frequency=freq,
            static_dir=static,
            force=not args.no_force,
        )
    )
    print("Hard-refresh the WebUI (Ctrl+Shift+R). Re-run after hermes-webui upgrades.")


if __name__ == "__main__":
    main()
