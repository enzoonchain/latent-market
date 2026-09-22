def _csrf_exempt_path(path: str) -> bool:
    """Paths that skip the CSRF check."""
    # latent-protocol-csrf-exempt-begin
    if ("/api/latent/" in (path or "")) or ("/__latent__/" in (path or "")):
        return True
    # latent-protocol-csrf-exempt-end
    return False


def handle_post(handler, parsed):
    # latent-protocol-proxy-begin
    try:
        _latent_path = getattr(parsed, "path", "") or ""
        if ("/api/latent/" in _latent_path or "/__latent__/" in _latent_path):
            from api.latent_ads_proxy import handle_latent_proxy
            return handle_latent_proxy(handler, parsed)
    except Exception:
        pass
    # latent-protocol-proxy-end
    return False
