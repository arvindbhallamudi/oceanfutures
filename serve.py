import http.server
import functools

# Plain http.server sends no cache-control headers at all, which lets
# browsers heuristically cache pages/assets indefinitely during dev —
# edits then silently don't show up until a hard refresh. This adds
# no-store so every response is always re-fetched fresh.
class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

if __name__ == "__main__":
    import os
    # Serves this fixed absolute path regardless of the process's own
    # cwd, so it works even when the launcher's shell can't resolve
    # its own working directory at startup.
    site_dir = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=site_dir)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 8743), handler)
    server.serve_forever()
