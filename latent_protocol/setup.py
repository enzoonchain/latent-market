"""Wallet setup and config persistence for Latent Protocol.

Config file: ~/.latent-protocol/config.json
Priority:    config file > env vars > built-in defaults
"""

from __future__ import annotations

import json
import re
from pathlib import Path

_CONFIG_DIR = Path.home() / ".latent-protocol"
_CONFIG_FILE = _CONFIG_DIR / "config.json"
_DEVICE_ID_FILE = _CONFIG_DIR / "device_id"
_EVM_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_DEVICE_CREDENTIAL_RE = re.compile(r"^[0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]+$", re.I)


# ── Config file helpers ──────────────────────────────────────────────────────

def load_config_file() -> dict:
    """Return saved config dict, or {} if none exists."""
    try:
        return json.loads(_CONFIG_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_config_file(data: dict) -> None:
    """Merge *data* into the config file (non-destructive for other keys)."""
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    existing = load_config_file()
    existing.update(data)
    _CONFIG_FILE.write_text(json.dumps(existing, indent=2))


def device_id() -> str:
    """Server-issued device credential shared with the TS surfaces.

    Empty when the file is missing or still holds a client-minted id. Never
    raises — ad serving must not depend on this file.
    """
    try:
        existing = _DEVICE_ID_FILE.read_text().strip()
    except OSError:
        return ""
    return existing if _DEVICE_CREDENTIAL_RE.match(existing) else ""


def ensure_device_credential(server: str) -> str:
    """Register with the ad server once and store the credential."""
    current = device_id()
    if current:
        return current
    try:
        import httpx

        resp = httpx.post(
            f"{server.rstrip('/')}/device/register",
            json={},
            timeout=2.0,
        )
        if resp.status_code != 200:
            return ""
        credential = str((resp.json() or {}).get("credential") or "").strip()
    except Exception:
        return ""
    if not _DEVICE_CREDENTIAL_RE.match(credential):
        return ""
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        if device_id():
            return device_id()
        _DEVICE_ID_FILE.write_text(credential)
    except OSError:
        return credential
    return device_id() or credential


# ── Wallet helpers ───────────────────────────────────────────────────────────

def is_valid_address(address: str) -> bool:
    return bool(_EVM_ADDRESS_RE.match(address))


# ── Interactive CLI setup ────────────────────────────────────────────────────

def run_interactive_setup() -> None:
    """Walk the user through first-time wallet configuration."""
    print("\n🚀 Latent Protocol Setup\n")

    cfg = load_config_file()
    if cfg.get("wallet"):
        print(f"Current wallet: {cfg['wallet']}")
        change = input("Change it? [y/N]: ").strip().lower()
        if change != "y":
            print("No changes made.")
            return

    print("\nHow do you want to get paid?")
    print("  [1] Email me a wallet (claim later in the browser)  (recommended)")
    print("  [2] I already have a 0x address")
    print("  Sign in with Google / X / an existing wallet instead: npx latent-protocol init")

    choice = input("\nChoice [1/2]: ").strip() or "1"

    if choice == "1":
        from .config import Config
        from .wallet import pregenerate_email

        email = input("Email: ").strip()
        try:
            earner = pregenerate_email(email, Config.from_env().server)
        except ValueError as exc:
            print(f"❌ {exc}")
            return
        save_config_file(
            {"wallet": earner["wallet"], "privy_user_id": earner["privy_user_id"], "auth": "privy"}
        )
        print(f"\n✅ Wallet ready for {email}: {earner['wallet']}")
        print(f"   Claim it (email OTP) at {earner['claim_url']}")

    elif choice == "2":
        while True:
            address = input("\nEnter your EVM wallet address (0x...): ").strip()
            if is_valid_address(address):
                break
            print("❌ Invalid address. Must be 0x followed by 40 hex characters.")
        save_config_file({"wallet": address, "auth": "address"})
        print(f"\n✅ Wallet saved to {_CONFIG_FILE}")

    else:
        print("Invalid choice. Run `latent-protocol setup` again.")
        return

    # Optional: customise frequency
    freq_raw = input(f"\nShow ads every N messages [default 1]: ").strip()
    if freq_raw.isdigit() and int(freq_raw) > 0:
        save_config_file({"frequency": int(freq_raw)})
    else:
        save_config_file({"frequency": 1})

    print("\n🎉 Setup complete! Your agent will now earn USDC from sponsored ads.")
    print(f"   Config: {_CONFIG_FILE}")
    print(f"   Check balance:   /ads balance  (Hermes)  |  check_balance()  (MCP)")
    print(f"   Request payout:  /ads payout   (Hermes)  |  request_payout() (MCP)\n")


def main() -> None:
    """Console-script entry point for `latent-protocol setup`."""
    run_interactive_setup()
