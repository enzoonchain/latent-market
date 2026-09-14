"""Client-side impression and click tracking (best-effort).

Call ``log_impression`` only after the creative is attached to output the
host will show the human. Never call it from ``/ad/request`` / ``get_ad``
alone — that would bill invisible ads. See ``latent_protocol.delivery``.
"""

import httpx


class Tracker:
    def __init__(self, server_url: str):
        self.server = server_url.rstrip("/")

    def log_impression(self, ad_id: str, wallet: str, token: str = "") -> None:
        """Report a confirmed display to the ad server (the server is the
        authority on what is billable). ``token`` is the signed impression
        token from the /ad/request response — required server-side.

        Must only be invoked at a display-commit point (footer attached,
        statusline returned, thinking banner mounted, etc.).
        """
        try:
            httpx.post(
                f"{self.server}/ad/impression",
                json={"ad_id": ad_id, "user_wallet": wallet, "token": token},
                timeout=2.0,
            )
        except httpx.HTTPError:
            pass  # best effort

    def log_click(self, ad_id: str, wallet: str, token: str = "") -> None:
        """Report a click. ``token`` is the signed click token from the
        /ad/request response — required server-side (S6 hardening): without
        it the server won't credit the 50x click bonus for anyone who merely
        knows an ad_id + wallet.
        """
        try:
            httpx.post(
                f"{self.server}/ad/click",
                json={"ad_id": ad_id, "user_wallet": wallet, "token": token},
                timeout=2.0,
            )
        except httpx.HTTPError:
            pass
