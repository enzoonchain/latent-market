"""Sanitize advertiser-controlled ad copy before it reaches any display sink.

Every adapter in this package renders ``body``/``title``/``cta_text`` from an
advertiser-controlled ad dict into a real sink: a terminal status line
(``adapters/claude_code.py``), raw ANSI in a CLI banner (``footer.py``'s
``cli`` style), or a Telegram/markdown message. None of those are safe for raw
bytes — a terminal acts on ESC/CSI/OSC sequences, and bidi-override codepoints
can visually disguise text or a link in any renderer, not just a terminal.

Mirrors ``cli/src/sanitize.ts`` (the TypeScript CLI's advertiser-text
sanitizer, added in latent-protocol#18) — this package never had an
equivalent, so no adapter here sanitized ad copy at all before this.
"""

import re
from urllib.parse import urlsplit

_ESC_SEQ = re.compile(
    r"\x1b\][\s\S]*?(?:\x07|\x1b\\|$)"  # OSC   ESC ] ... (BEL | ST)
    r"|\x1b\[[0-?]*[ -/]*[@-~]"  # CSI   ESC [ params intermediates final
    r"|\x1b[ -/]*[0-~]"  # nF    ESC intermediates final
    r"|\x1b[@-_]"  # Fe    ESC single-char
)

# Every C0 control (incl. ESC 0x1B), DEL, and every C1 control (incl. 8-bit CSI 0x9B).
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")

# Bidi overrides / isolates / deprecated formatting chars.
_BIDI = re.compile(r"[‪-‮⁦-⁩‎‏؜]")

_WHITESPACE = re.compile(r"\s+")

# `format_footer`'s telegram/markdown styles render this text inside a
# markdown-parsed message. `[`/`]` are what forms a `[text](url)` link — an
# advertiser body/cta_text containing its own bracket pair could inject a
# second, unvalidated link that never went through `is_safe_https_url`,
# bypassing the cta_url gate entirely. Swap for visually-similar fullwidth
# brackets (not markdown-active) rather than stripping, so the text still
# reads naturally.
_MD_LINK_BRACKETS = str.maketrans({"[": "［", "]": "］"})


def sanitize_ad_text(text: str | None, max_len: int = 140) -> str:
    """Clean advertiser text for a display sink.

    ``max_len`` clamps the visible length (an ellipsis is appended when
    clipped). Returns ``""`` for ``None``/empty input. Deliberately lossy —
    anything ambiguous is dropped, not escaped.
    """
    s = str(text or "")
    s = _ESC_SEQ.sub("", s)
    s = _CONTROL.sub(" ", s)
    s = _BIDI.sub("", s)
    s = s.translate(_MD_LINK_BRACKETS)
    s = _WHITESPACE.sub(" ", s).strip()
    if max_len > 0 and len(s) > max_len:
        s = s[: max(0, max_len - 1)].rstrip() + "…"
    return s


def is_safe_https_url(url: str | None) -> bool:
    """Only ``https://`` targets may become a clickable link.

    An ad's ``cta_url`` is third-party data; emitting a ``javascript:`` /
    ``data:`` / ``file:`` scheme, or one with an embedded control character
    (C0 *or* C1 — the same range `sanitize_ad_text`'s `_CONTROL` rejects for
    ad body text, e.g. the single-byte CSI introducer 0x9B) that could break
    out of a markdown link or a terminal escape, is unsafe. Also rejects a
    bidi-override codepoint (could visually disguise the domain) and an
    embedded userinfo (``user@host`` — reads as a trusted domain up to the
    ``@`` while actually pointing elsewhere).
    """
    if not isinstance(url, str) or not url.startswith("https://"):
        return False
    if _CONTROL.search(url) or _BIDI.search(url):
        return False
    parts = urlsplit(url)
    return "@" not in parts.netloc


# Per-field caps matching protocol/openapi.yaml (and cli/src/sanitize.ts).
AD_LIMITS = {"title": 30, "body": 140, "cta_text": 24}
