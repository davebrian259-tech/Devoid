# Web smoke test: builds dist/ the way Cloudflare gets it, serves it with the headers from
# site/_headers (so the real Content-Security-Policy applies), then opens the product page, follows
# "Open the wallet", and uses the web demo end to end on a desktop and a phone screen. Fails on any
# console error, CSP violation or network request the demo makes.
#
#   python3 scripts/web-smoke.py
#   DEVOID_CHROMIUM=/path/to/chrome python3 scripts/web-smoke.py
import http.server, os, re, subprocess, threading, glob, mimetypes
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
subprocess.run(['node', 'scripts/build-site.mjs'], cwd=ROOT, check=True)


def parse_headers(path):
    """Cloudflare's _headers format: a URL pattern, then indented "Name: value" lines."""
    rules, cur = [], None
    for line in open(path):
        if not line.strip() or line.lstrip().startswith('#'): continue
        if line[0] in ' \t':
            k, v = line.strip().split(':', 1); cur[1].append((k.strip(), v.strip()))
        else:
            cur = (line.strip(), []); rules.append(cur)
    return rules


RULES = parse_headers(os.path.join(DIST, '_headers'))
TYPES = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.txt': 'text/plain'}


class Handler(http.server.BaseHTTPRequestHandler):
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
        for pattern, headers in RULES:
            if url == pattern or (pattern.endswith('*') and url.startswith(pattern[:-1])):
                for k, v in headers: self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)


srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{srv.server_address[1]}'
os.makedirs('shots', exist_ok=True)
for old in glob.glob('shots/web-*.png'): os.remove(old)
errors, requests = [], []
LAYOUT_CHECK = open(os.path.join(ROOT, 'scripts', 'overlap.js')).read()


def check(pg, name):
    pg.wait_for_timeout(250)
    text = pg.evaluate('document.body.innerText')
    for leak in ('null', 'undefined', 'NaN', '[object Object]'):
        assert not re.search(r'(?<![\w-])' + re.escape(leak) + r'(?![\w-])', text), f'{name}: "{leak}" is showing on screen'
    # Nothing may sit on top of anything else, spill out of its box, or hide under the tab bar.
    problems = pg.evaluate(LAYOUT_CHECK)
    assert not problems, f'{name}: layout problems:\n  ' + '\n  '.join(problems)


def shot(pg, name, full=False):
    check(pg, name)
    pg.screenshot(path=f'shots/web-{name}.png', full_page=full)


def watch(pg):
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append(str(e)))
    # The page loads its own files; anything else, or any fetch at all, would be a leak.
    pg.on('request', lambda r: requests.append(r.url) if not r.url.startswith(base) or r.resource_type in ('fetch', 'xhr', 'websocket', 'eventsource') else None)


def create_wallet(pg, passphrase):
    pg.wait_for_selector('#p1')
    expect(pg.locator('.seg button:has-text("Restore")')).to_have_count(0)  # the web version never takes a phrase
    expect(pg.locator('[aria-label=Network]')).to_have_count(0)  # and is testnet only
    expect(pg.locator('.note.test')).to_contain_text('testnet')
    pg.fill('#p1', passphrase); pg.fill('#p2', passphrase); pg.click('text=Create wallet')
    pg.wait_for_selector('.phrase span')
    words = [s.inner_text() for s in pg.query_selector_all('.phrase span')]
    expect(pg.locator('.note')).to_contain_text('demo words')
    pg.check('#wrote'); pg.click('text=Continue')
    for inp in pg.query_selector_all('input[data-word]'): inp.fill(words[int(inp.get_attribute('data-word')) - 1])
    pg.click('text=Open my wallet'); pg.wait_for_selector('.poolbar')


try:
    with sync_playwright() as p:
        exe = os.environ.get('DEVOID_CHROMIUM')
        b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()

        # ---- desktop: front page to a sent batch -----------------------------------------------------
        ctx = b.new_context(viewport={'width': 1366, 'height': 900}, accept_downloads=True)
        pg = ctx.new_page(); watch(pg)
        pg.goto(base + '/')
        expect(pg.locator('#open-wallet')).to_be_visible()
        shot(pg, '01-front')
        pg.click('#open-wallet')
        pg.wait_for_url(base + '/app/')
        pg.wait_for_selector('.form-card')
        shot(pg, '02-welcome')
        create_wallet(pg, 'demo passphrase 1')
        expect(pg.locator('.band.sim')).to_contain_text('Web demo')
        expect(pg.locator('.top .net')).to_contain_text('Testnet')
        shot(pg, '03-home')

        pg.click('a[data-view=receive]'); pg.wait_for_selector('svg.qr')
        mine = pg.inner_text('#addr'); assert mine.startswith('utest1'), mine
        pg.click('a[data-view=send]'); pg.wait_for_selector('#batch')
        rows = ['address,amount,memo'] + [f'{mine},0.02,web {i}' for i in range(3)]
        pg.fill('#batch', '\n'.join(rows)); pg.click('text=Check recipients'); pg.wait_for_selector('.ledger')
        expect(pg.locator('#review')).to_be_enabled()
        pg.click('#review'); pg.wait_for_selector('.sheet')
        expect(pg.locator('#review-total')).to_contain_text('0.06')
        pg.fill('#pw', 'wrong-passphrase'); pg.click('#confirm')
        expect(pg.locator('.note.err')).to_contain_text('passphrase')
        pg.fill('#pw', 'demo passphrase 1'); pg.click('#confirm')
        pg.wait_for_selector('#sent-total', timeout=60_000)
        expect(pg.locator('.txid')).to_have_count(1)
        shot(pg, '04-sent')

        # ---- it is still there after a reload, and Reset clears it ------------------------------------
        pg.reload(); pg.wait_for_selector('.side .nav')  # back on the same screen, wallet intact
        pg.click('a[data-view=activity]')
        expect(pg.locator('#view')).to_contain_text('Sent to 3 recipients')
        pg.click('a[data-view=settings]'); pg.wait_for_selector('text=Reset the demo')
        expect(pg.locator('text=Network connection')).to_have_count(0)
        shot(pg, '05-settings', full=True)
        pg.click('button:has-text("Reset the demo")'); pg.click('dialog button:has-text("Reset")')
        pg.wait_for_selector('#p1')
        assert pg.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('devoid-web:')).length") == 0
        ctx.close()

        # ---- the site's pages at every common width, light and dark ------------------------------------
        for scheme in ('light', 'dark'):
            for w in (1440, 1100, 820, 390, 320):
                ctx = b.new_context(viewport={'width': w, 'height': 860}, color_scheme=scheme); pg = ctx.new_page(); watch(pg)
                for path in ('/', '/privacy.html'):
                    pg.goto(base + path); expect(pg.locator('footer .foot-grid')).to_be_visible()
                    name = f'site-{scheme}-{w}{path.replace("/", "-").replace(".html", "")}'
                    if path == '/' and w in (1440, 390): pg.locator('footer').screenshot(path=f'shots/web-footer-{scheme}-{w}.png')
                    check(pg, name)
                ctx.close()

        # ---- phone: the whole thing on a small screen ------------------------------------------------
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); watch(pg)
        pg.goto(base + '/')
        assert pg.evaluate('document.documentElement.scrollWidth') <= 390, 'the front page scrolls sideways on a phone'
        shot(pg, '06-phone-front')
        pg.click('header .btn:has-text("Open wallet")'); pg.wait_for_url(base + '/app/')
        create_wallet(pg, 'demo passphrase 2')
        expect(pg.locator('.tabbar')).to_be_visible()
        assert pg.evaluate('document.documentElement.scrollWidth') <= 390, 'the app scrolls sideways on a phone'
        shot(pg, '07-phone-home', full=True)
        pg.click('a[data-tab=send]'); pg.wait_for_selector('#batch')
        shot(pg, '08-phone-send', full=True)
        # The smallest phones still in use: every screen at 320px wide.
        pg.set_viewport_size({'width': 320, 'height': 640})
        for tab in ('home', 'send', 'receive', 'activity'):
            pg.click(f'a[data-tab={tab}]'); pg.wait_for_timeout(300); check(pg, f'320-{tab}')
        pg.click('a[data-tab=more]'); pg.click('.menu-list a:has-text("Settings")'); pg.wait_for_selector('text=Reset the demo'); check(pg, '320-settings')

        # The layout check itself must catch a real overlap, or the passes above mean nothing.
        pg.evaluate("document.querySelectorAll('#view .card + .card').forEach((c) => c.style.setProperty('margin-top', '-60px', 'important'))")
        assert any(p.startswith('overlap:') for p in pg.evaluate(LAYOUT_CHECK)), 'the layout check missed a planted overlap'
        ctx.close()

        # ---- a direct visit to /app works, and unknown pages get the 404 page -------------------------
        ctx = b.new_context(); pg = ctx.new_page(); watch(pg)
        pg.goto(base + '/app'); pg.wait_for_selector('#p1')
        ctx.close()
        ctx = b.new_context(); pg = ctx.new_page()  # not watched: the 404 is expected here
        r = pg.goto(base + '/nope'); assert r.status == 404
        expect(pg.locator('a[href="/app/"]')).to_be_visible()
        ctx.close()
        b.close()
finally:
    srv.shutdown()

print('console errors:', errors)
print('unexpected requests:', requests)
assert not errors, errors
assert not requests, requests
print('web smoke: all steps passed')
