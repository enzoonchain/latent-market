"""Fetch ads from the Latent Protocol marketplace."""

import httpx

from .setup import device_id


class AdClient:
    def __init__(self, server_url: str):
        self.server = server_url.rstrip("/")

    def get_ad(
        self,
        wallet: str,
        context: str,
        agent: str = "mcp",
        surface: str = "any",
    ) -> dict | None:
        """Request the best matching ad from the marketplace.

        Returns an ad dict, or None if no ad is available. Hard 2s timeout —
        never slow down the agent; fail open on any error.
        """
        try:
            resp = httpx.post(
                f"{self.server}/ad/request",
                json={
                    "user_wallet": wallet,
                    "agent": agent,
                    "context": context,
                    "surface": surface,
                    "device_id": device_id(),
                },
                timeout=2.0,
            )
            if resp.status_code == 200:
                return resp.json()
        except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError):
            pass  # fail open — agent works without ads
        return None
