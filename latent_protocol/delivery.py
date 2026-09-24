"""Ad delivery lifecycle — reserve → render → confirm → bill.

Billing integrity rule
----------------------
``/ad/request`` only *reserves* a creative + signed token. It is **not**
billable. ``Tracker.log_impression`` (POST ``/ad/impression``) may run only
after the creative is attached to output that the host will show the human.

Fail-open for UX (agent never blocks on ads). Fail-closed for money
(no confirm → no earnings / no advertiser debit).
"""

from __future__ import annotations

from .ad_client import AdClient
from .classify import classify
from .tracker import Tracker

# Markers produced by ``footer.format_footer`` / statusline / thinking lines.
SPONSORED_MARKERS = (
    "Sponsored:",
    "*Sponsored:*",
    "**Sponsored:**",
    "Sponsored while you wait",
)


def already_displayed(text: str) -> bool:
    """True if *text* already contains a Latent sponsored creative."""
    body = text or ""
    return any(m in body for m in SPONSORED_MARKERS)


def reserve_ad(
    client: AdClient,
    *,
    wallet: str,
    context: str,
    agent: str,
    surface: str,
) -> dict | None:
    """Fetch an ad + impression_token. Does **not** bill.

    ``context`` is the caller's raw targeting text — several adapters pass the
    user's actual message or the assistant's response text here (see e.g.
    ``adapters/telegram.py``'s docstring). That text must never leave this
    machine: it is classified into a coarse category slug (``classify.py``,
    mirrors ``cli/src/classify.ts``) before the request goes out, same as
    every other Latent surface already does.
    """
    return client.get_ad(
        wallet=wallet,
        context=classify(context),
        agent=agent,
        surface=surface,
    )


def confirm_display(
    tracker: Tracker,
    ad: dict | None,
    wallet: str,
    displayed_ms: int | None = None,
) -> bool:
    """Bill one impression for a creative that was attached to delivered output.

    Returns True if an impression POST was attempted (ad had an id). The server
    remains the authority on whether the event is accepted (token, dedup, etc.).
    ``displayed_ms`` is forwarded when the caller measured real dwell.
    """
    if not ad or not wallet:
        return False
    ad_id = ad.get("ad_id") or ad.get("id") or ""
    if not ad_id:
        return False
    token = ad.get("impression_token", "")
    if displayed_ms is None:
        tracker.log_impression(ad_id, wallet, token)
    else:
        tracker.log_impression(ad_id, wallet, token, displayed_ms=displayed_ms)
    return True


def confirm_if_displayed(
    tracker: Tracker,
    ad: dict | None,
    wallet: str,
    delivered_text: str,
) -> bool:
    """Confirm only when *delivered_text* contains a sponsored marker."""
    if not already_displayed(delivered_text):
        return False
    return confirm_display(tracker, ad, wallet)
