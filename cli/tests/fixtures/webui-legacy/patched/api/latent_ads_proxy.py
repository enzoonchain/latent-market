"""Latent Protocol same-origin ad proxy for Hermes WebUI.

Browser CSP blocks connect-src to the Latent API. Exposes
/api/latent/ad/* and /__latent__/ad/* and forwards to Latent.
"""
# latent-protocol-proxy
from __future__ import annotations

import json
import urllib.error
import urllib.request

LATENT_SERVER = "https://api.latentprotocol.xyz"
PREFIXES = (
    "/api/latent",
    "/__latent__",
)
ALLOWED = {"/ad/request", "/ad/impression"}
MAX_BODY = 1_000_000


def _suffix_for(path):
    # Support subpath mounts: /hermes/api/latent/ad/request -> /ad/request
    for prefix in PREFIXES:
        needle = prefix + "/"
        idx = path.find(needle)
        if idx >= 0:
            return path[idx + len(prefix) :] or ""
        if path.endswith(prefix):
            return ""
    return None


def handle_latent_proxy(handler, parsed):
    """Proxy POST /api/latent/ad/* and /__latent__/ad/* to Latent API."""
    suffix = _suffix_for(parsed.path)
    if suffix is None or suffix not in ALLOWED:
        body = json.dumps({"error": "not found", "path": parsed.path}).encode()
        handler.send_response(404)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
        return True

    try:
        length = int(handler.headers.get("Content-Length", "0") or "0")
    except ValueError:
        length = 0
    if length < 0 or length > MAX_BODY:
        body = b'{"error":"body too large"}'
        handler.send_response(413)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
        return True

    raw = handler.rfile.read(length) if length else b"{}"
    url = LATENT_SERVER.rstrip("/") + suffix
    req = urllib.request.Request(
        url,
        data=raw,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "latent-protocol-webui-proxy/1",
        },
        method="POST",
    )
    status = 502
    ctype = "application/json"
    data = b'{"error":"proxy_failed"}'
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
            status = getattr(resp, "status", 200) or 200
            ctype = resp.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as err:
        data = err.read() or data
        status = err.code
        ctype = err.headers.get("Content-Type", "application/json") if err.headers else ctype
    except Exception as exc:
        data = json.dumps({"error": "proxy_failed", "detail": str(exc)}).encode()
        status = 502

    handler.send_response(status)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    try:
        handler.wfile.write(data)
    except Exception:
        pass
    return True
