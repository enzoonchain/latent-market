_CSP_CONNECT_BASE = (
    "'self' http://127.0.0.1:* http://localhost:*"
)


def _csp_connect_src(extra_connect_src=""):
    return f"{_CSP_CONNECT_BASE} https://cdn.jsdelivr.net https://api.latentprotocol.xyz{extra_connect_src}"
