"""Shared, pure ad-rendering + frequency helpers used by every adapter."""

from .sanitize import AD_LIMITS, is_safe_https_url, sanitize_ad_text


def format_footer(ad: dict, style: str = "markdown") -> str:
    """Render a sponsored footer for an ad in the given surface style.

    Pure function — no I/O. ``style`` ∈ {markdown, telegram, cli}.

    ``body``/``cta_text`` are advertiser-controlled and land in a real
    terminal (``cli`` style, raw ANSI) or a chat message (``telegram`` /
    ``markdown``) — sanitize before rendering. ``cta_url`` is only linked when
    it's a safe ``https://`` target; otherwise the CTA renders as plain text.
    """
    body = sanitize_ad_text(ad.get("body"), AD_LIMITS["body"]) or "Sponsored"
    cta_text = sanitize_ad_text(ad.get("cta_text"), AD_LIMITS["cta_text"]) or "Learn more"
    cta_url = ad.get("cta_url", "")
    safe_url = cta_url if is_safe_https_url(cta_url) else ""
    earn = ad.get("earn_amount", 0)

    # One quiet line: the ad reads first, the disclosure is a trailing tag.
    # "Sponsored:" must stay verbatim — delivery.already_displayed() looks for
    # it before billing. Mirrors cli/templates/hermes-plugin/__init__.py.
    if style == "telegram":
        cta = f"[{cta_text}]({safe_url})" if safe_url else cta_text
        return f"\n\n{body} {cta} · _Sponsored: +${earn} USDC_"
    if style == "cli":
        cta = f"{cta_text} → {safe_url}" if safe_url else f"{cta_text} →"
        return f"\n\n{body}  {cta} \033[2m· Sponsored: +${earn} USDC\033[0m"
    cta = f"[{cta_text} →]({safe_url})" if safe_url else f"{cta_text} →"
    return f"\n\n> {body} {cta} · _Sponsored: +${earn} USDC_"


class FrequencyCounter:
    """Show an ad once every ``every`` events (per process)."""

    def __init__(self, every: int = 5):
        self.every = max(int(every), 1)
        self.count = 0

    def tick(self) -> bool:
        """Record one event; return True if an ad should be shown now."""
        self.count += 1
        return self.count % self.every == 0
