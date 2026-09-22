"""User wallet / earnings helpers (talk to the ad server API)."""

import httpx


def get_balance(wallet: str, server: str) -> float:
    """Current claimable earnings balance for a wallet."""
    try:
        resp = httpx.get(f"{server.rstrip('/')}/earnings/{wallet}", timeout=5.0)
        if resp.status_code == 200:
            return float(resp.json().get("balance", 0.0))
    except httpx.HTTPError:
        pass
    return 0.0


def request_payout(wallet: str, server: str) -> str:
    """Request a payout of accumulated earnings; returns a tx hash or status."""
    try:
        resp = httpx.post(
            f"{server.rstrip('/')}/payout/request",
            json={"wallet_address": wallet},
            timeout=10.0,
        )
        if resp.status_code == 200:
            return resp.json().get("tx_hash", "pending")
    except httpx.HTTPError:
        pass
    return "error"


DEFAULT_CLAIM_URL = "https://www.latentprotocol.xyz/authorize"


def pregenerate_email(email: str, server: str) -> dict:
    """Ask the ad server for a Privy wallet bound to *email*.

    The wallet is claimable later (email OTP at the returned ``claim_url``); no
    private key ever exists on this machine. Returns ``wallet``,
    ``privy_user_id`` and ``claim_url``. Raises ``ValueError`` with the
    server's reason on any failure.
    """
    if "@" not in email:
        raise ValueError("invalid email")
    try:
        resp = httpx.post(
            f"{server.rstrip('/')}/auth/pregenerate",
            json={"email": email},
            timeout=15.0,
        )
    except httpx.HTTPError as exc:
        raise ValueError(f"pregenerate failed: {exc}") from exc
    try:
        body = resp.json()
    except ValueError:
        body = {"detail": resp.text or f"HTTP {resp.status_code}"}
    if resp.status_code != 200:
        detail = body.get("detail") if isinstance(body, dict) else None
        raise ValueError(detail if isinstance(detail, str) else f"pregenerate HTTP {resp.status_code}")
    if not body.get("wallet") or not body.get("privy_user_id"):
        raise ValueError("pregenerate returned no wallet")
    return {
        "wallet": body["wallet"],
        "privy_user_id": body["privy_user_id"],
        "claim_url": body.get("claim_url") or DEFAULT_CLAIM_URL,
    }
