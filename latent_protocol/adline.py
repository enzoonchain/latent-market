"""One sponsor line, and the scheme-less URL a terminal can show."""

from .sanitize import sanitize_ad_text

BRAND_MAX = 30
BODY_MAX = 60


def _clamp(value: str, max_len: int) -> str:
    t = value.strip()
    if len(t) <= max_len:
        return t
    return t[: max(1, max_len - 1)].rstrip() + "…"


def dedupe_brand(brand: str, body: str) -> str:
    """Drop a leading brand so the line doesn't say it twice."""
    t = body.strip()
    b = brand.strip()
    if not b:
        return t
    lb = b.lower()
    while t.lower().startswith(lb):
        after = t[len(b) : len(b) + 1]
        if after and after.isalnum():
            break
        rest = t[len(b) :].lstrip(" \t-:–—")
        if rest == t:
            break
        t = rest
        if t == "":
            break
    return t


def compose_ad_line(title, body) -> str:
    """`Brand — body`. Brand ≤ 30, body ≤ 60. Empty side is omitted."""
    brand_raw = sanitize_ad_text(title if isinstance(title, str) else "", 0)
    body_raw = sanitize_ad_text(body if isinstance(body, str) else "", 0)
    line = _clamp(dedupe_brand(brand_raw, body_raw), BODY_MAX)
    brand = _clamp(brand_raw, BRAND_MAX)
    if brand and line:
        return f"{brand} — {line}"
    return brand or line


def display_url(url: str) -> str:
    """Host, path, and query. The https scheme stays off the visible line."""
    if isinstance(url, str) and url.startswith("https://"):
        return url[len("https://") :]
    return ""
