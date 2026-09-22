def is_auth_enabled():
    return True


def check_auth(handler, parsed):
    """Return True when the request may proceed."""
    if (
        parsed.path.startswith('/static/')
        or parsed.path.startswith('/session/static/')
    ):
        return True
    return False
