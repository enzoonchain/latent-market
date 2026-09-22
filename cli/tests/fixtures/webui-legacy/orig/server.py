from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse
from api.auth import check_auth, is_auth_enabled


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        parsed = urlparse(self.path)
        self._handle_write(None)

    def _handle_write(self, route_func):
        parsed = urlparse(self.path)
        if True:
            if not check_auth(self, parsed):
                return
        route_func(self, parsed)


def main():
    pass


if __name__ == "__main__":
    main()
