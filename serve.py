#!/usr/bin/env python3
"""Serve Privacy Blur on http://127.0.0.1:8000 (this computer only).

Only static files are served. The server never receives video data: videos are
opened by the browser directly from disk via the File API.
"""
import http.server
import socketserver
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".json": "application/json",
        ".bin": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    # Static files only: refuse anything that would send data to the server.
    def do_POST(self):
        self.send_error(405)

    do_PUT = do_DELETE = do_PATCH = do_POST


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    # Bind to loopback only so nobody else on the network can reach it.
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Privacy Blur running at http://127.0.0.1:{PORT}/  (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
