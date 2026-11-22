"""Local dev server for CaliTracker: static files with caching disabled.

Usage: python3 serve.py [port]   (default 5173)
Add --host 0.0.0.0 to open it from your phone on the same Wi-Fi.
"""
import http.server
import sys
from functools import partial
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".webmanifest": "application/manifest+json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    args = sys.argv[1:]
    host = "127.0.0.1"
    if "--host" in args:
        i = args.index("--host")
        host = args[i + 1]
        del args[i:i + 2]
    port = int(args[0]) if args else 5173
    handler = partial(NoCacheHandler, directory=str(Path(__file__).parent))
    with http.server.ThreadingHTTPServer((host, port), handler) as httpd:
        print(f"CaliTracker running at http://{host}:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
