def is_auth_enabled():
    return True


def check_auth(handler, parsed):
    """Return True when the request may proceed."""
    # latent-protocol-auth-exempt-begin
    _lp = getattr(parsed, "path", "") or ""
    if ("/api/latent/" in _lp) or ("/__latent__/" in _lp):
        return True
    # latent-protocol-auth-exempt-end
    if (
        parsed.path.startswith('/static/')
        or parsed.path.startswith('/session/static/')
        # latent-protocol-auth-exempt-begin
        or ("/api/latent/" in parsed.path)
        or ("/__latent__/" in parsed.path)
        # latent-protocol-auth-exempt-end
    ):
        return True
    return False
