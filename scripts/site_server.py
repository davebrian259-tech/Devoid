# Builds dist/ and serves it the way Cloudflare does: the same files, the same response headers
# from _headers (including "! Name" detaching a header an earlier rule set), and the 404 page.
# Used by the browser tests (web-smoke.py, web-live.py).
import functools, http.server, mimetypes, os, subprocess, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
TYPES = {'.wasm': 'application/wasm', '.params': 'application/octet-stream', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.txt': 'text/plain'}


def parse_headers(path):
    """Cloudflare's _headers format: a URL pattern, then indented "Name: value" lines."""
    rules, cur = [], None
    for line in open(path):
        if not line.strip() or line.lstrip().startswith('#'): continue
        if line[0] in ' \t':
            entry = line.strip()
            if entry.startswith('!'): cur[1].append((entry[1:].strip(), None)); continue
            k, v = entry.split(':', 1); cur[1].append((k.strip(), v.strip()))
        else:
            cur = (line.strip(), []); rules.append(cur)
    return rules


class Handler(http.server.BaseHTTPRequestHandler):
    def __init__(self, rules, *args, **kwargs):
        self.rules = rules
        super().__init__(*args, **kwargs)

    def log_message(self, *a): pass

    def do_GET(self):
        url = self.path.split('?')[0]
        path = os.path.normpath(os.path.join(DIST, url.lstrip('/')))
        status = 200
        if not path.startswith(DIST): status, path = 404, os.path.join(DIST, '404.html')
        elif os.path.isdir(path):
            if not url.endswith('/'):
                self.send_response(307); self.send_header('Location', url + '/'); self.end_headers(); return
            path = os.path.join(path, 'index.html')
        if not os.path.isfile(path) or os.path.basename(path) == '_headers': status, path = 404, os.path.join(DIST, '404.html')
        body = open(path, 'rb').read()
        self.send_response(status)
        self.send_header('Content-Type', TYPES.get(os.path.splitext(path)[1], mimetypes.guess_type(path)[0] or 'application/octet-stream'))
        out = []
        for pattern, headers in self.rules:
            if url == pattern or (pattern.endswith('*') and url.startswith(pattern[:-1])):
                for k, v in headers:
                    if v is None: out = [(n, x) for n, x in out if n.lower() != k.lower()]
                    else: out.append((k, v))
        for k, v in out: self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)


def build_and_serve():
    """Builds dist/ and serves it on a free local port. Returns (server, base URL)."""
    subprocess.run(['node', 'scripts/build-site.mjs'], cwd=ROOT, check=True)
    rules = parse_headers(os.path.join(DIST, '_headers'))
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, rules))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}'
