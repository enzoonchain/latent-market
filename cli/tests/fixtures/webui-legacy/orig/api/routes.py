def _csrf_exempt_path(path: str) -> bool:
    """Paths that skip the CSRF check."""
    return False


def handle_post(handler, parsed):
    return False
