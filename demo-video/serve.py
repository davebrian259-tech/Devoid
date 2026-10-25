# Serves the built site (dist/) on http://localhost:8790 with the response headers Cloudflare uses,
# so the demo is filmed against exactly what is deployed. Run from the repository root:
#   python3 demo-video/serve.py
import functools, http.server, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from site_server import DIST, Handler, parse_headers  # noqa: E402
import subprocess
subprocess.run(['node', 'scripts/build-site.mjs'], cwd=ROOT, check=True)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8790), functools.partial(Handler, parse_headers(os.path.join(DIST, '_headers'))))
print('serving http://localhost:8790', flush=True)
srv.serve_forever()
