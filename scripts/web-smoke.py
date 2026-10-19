# Web smoke test: builds dist/ the way Cloudflare gets it, serves it with the headers from
# site/_headers (so the real Content-Security-Policy applies), then opens the product page, follows
# "Open the wallet", and uses the web demo end to end on a desktop and a phone screen. Fails on any
# console error, CSP violation or network request the demo makes.
#
#   python3 scripts/web-smoke.py
#   DEVOID_CHROMIUM=/path/to/chrome python3 scripts/web-smoke.py
import os, re, glob, sys
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from site_server import ROOT, build_and_serve

srv, base = build_and_serve()
os.makedirs('shots', exist_ok=True)
for old in glob.glob('shots/web-*.png'): os.remove(old)
errors, requests = [], []
LAYOUT_CHECK = open(os.path.join(ROOT, 'scripts', 'overlap.js')).read()
# Whether the web wallet offers mainnet yet (ui/lib.js); the tests follow the switch.
WEB_MAINNET = 'export const WEB_MAINNET = true;' in open(os.path.join(ROOT, 'ui', 'lib.js')).read()


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
    # The page loads its own files; anything else, or any fetch at all, would be a leak. The one
    # fetches allowed are the real engine's own, on this site: its WebAssembly and the Sapling parameters.
    pg.on('request', lambda r: requests.append(r.url) if not r.url.startswith(base) or (r.resource_type in ('fetch', 'xhr', 'websocket', 'eventsource') and not r.url.startswith(base + '/app/engine/')) else None)


def create_wallet(pg, passphrase):
    pg.wait_for_selector('#p1')
    expect(pg.locator('.seg button:has-text("Restore")')).to_have_count(0)  # the web version never takes a phrase
    expect(pg.locator('.note.test')).to_contain_text('test network')  # a real testnet wallet is the default
    if WEB_MAINNET:
        pg.click('[aria-label=Network] button:has-text("Mainnet")')  # mainnet asks for a deliberate tick
        expect(pg.locator('.note.warn')).to_contain_text('real ZEC')
        expect(pg.locator('#mainnet-ack')).to_have_count(1)
    else:
        expect(pg.locator('[aria-label=Network]')).to_have_count(0)  # not open on the web yet
    pg.click('.seg button:has-text("Demo")')
    expect(pg.locator('.note.test')).to_contain_text('play money')
    expect(pg.locator('[aria-label=Network]')).to_have_count(0)  # the demo is testnet only
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
        pg.click('a[data-view=send]'); pg.wait_for_selector('.rcp')
        pg.click('[aria-label="How to add recipients"] button:has-text("Paste a list")'); pg.wait_for_selector('#batch')
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
        pg.click('a[data-tab=send]'); pg.wait_for_selector('[data-rcp="1"]')
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

        # ---- the real engine: loads under the wallet's CSP, passes its self-test, and proves -------------
        # The same engine the testnet wallet runs, offline: its self-test (keys, database, addresses,
        # recipient checks), then one throw-away transaction built and proved with Sapling and Orchard
        # proofs. A wallet that cannot prove must never reach a real send.
        ctx = b.new_context(); pg = ctx.new_page(); watch(pg)
        pg.goto(base + '/app/'); pg.wait_for_selector('#p1')
        engine = '''(message) => new Promise((resolve) => {
          const w = new Worker('/app/engine/worker.js', { type: 'module' });
          w.onmessage = ({ data }) => { if (!data.event) { resolve(data.result); w.terminate(); } };
          w.onerror = (e) => resolve({ ok: false, error: { code: 'worker', message: e.message } });
          w.postMessage({ id: 1, ...message });
        })'''
        st = pg.evaluate(f'({engine})({{ type: "run", request: {{ cmd: "selftest" }} }})')
        assert st['ok'] and st['result']['failed'] == 0, st
        proof = pg.evaluate(f'({engine})({{ type: "checkProving" }})')
        assert proof['ok'] and proof['result']['orchardActions'] >= 1 and proof['result']['saplingOutputs'] >= 1, proof
        print(f"real engine: self-test {st['result']['passed']} passed; a transaction proved in {proof['result']['proveMs'] / 1000:.0f}s ({proof['result']['bytes']} bytes)")
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
