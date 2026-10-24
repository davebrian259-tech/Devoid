# Web smoke test: builds dist/ the way Cloudflare gets it, serves it with the headers from
# site/_headers (so the real Content-Security-Policy applies), then opens the product page, follows
# "Open the wallet", and uses the web demo end to end on a desktop and a phone screen. Fails on any
# console error, CSP violation or network request the demo makes.
#
#   python3 scripts/web-smoke.py
#   DEVOID_CHROMIUM=/path/to/chrome python3 scripts/web-smoke.py
import json, os, re, glob, sys
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
# The files the service worker keeps so the app opens offline: it fetches them itself, from this
# site, when it installs. Anything else fetched is a leak (see watch()).
SHELL = set()


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
    pg.on('request', lambda r: requests.append(r.url) if not r.url.startswith(base) or (r.resource_type in ('fetch', 'xhr', 'websocket', 'eventsource') and not r.url.startswith(base + '/app/engine/') and r.url not in SHELL) else None)


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


SHELL.update(base + '/app/' + f.removeprefix('./') for f in json.loads(
    re.search(r'const FILES = (\[.*?\]);', open(os.path.join(ROOT, 'dist', 'app', 'sw.js')).read(), re.S).group(1)))

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
        # Padding: three recipients, but the chain is shown five outputs, for two more actions.
        expect(pg.locator('#view')).to_contain_text('the output count and the fee show that 3 people were paid')
        pg.check('#pad')
        expect(pg.locator('#view')).to_contain_text('padded to 5 outputs')
        pg.click('#review'); pg.wait_for_selector('.sheet')
        expect(pg.locator('.sheet')).to_contain_text('5 outputs on chain')
        expect(pg.locator('.sheet')).to_contain_text('Padded to 5 outputs')
        expect(pg.locator('#review-total')).to_contain_text('0.06')
        pg.fill('#pw', 'wrong-passphrase'); pg.click('#confirm')
        expect(pg.locator('.note.err')).to_contain_text('passphrase')
        pg.fill('#pw', 'demo passphrase 1'); pg.click('#confirm')
        pg.wait_for_selector('#sent-total', timeout=60_000)
        expect(pg.locator('.txid')).to_have_count(1)
        shot(pg, '04-sent')

        # Signed once: the next payment does not ask for the passphrase again, until it is locked.
        pg.click('.side-cta'); pg.wait_for_selector('#batch, .rcp')
        if not pg.locator('#batch').count():
            pg.click('[aria-label="How to add recipients"] button:has-text("Paste a list")'); pg.wait_for_selector('#batch')
        pg.fill('#batch', f'{mine},0.01,again'); pg.click('text=Check recipients'); pg.wait_for_selector('.ledger')
        pg.click('#review'); pg.wait_for_selector('.sheet')
        expect(pg.locator('#lock-now')).to_be_visible(); expect(pg.locator('#pw')).to_have_count(0)
        pg.click('#lock-now'); expect(pg.locator('#pw')).to_be_visible()
        pg.click('button:has-text("Back to recipients")')

        # ---- a passkey unlocks the wallet, with no passphrase typed (WebAuthn PRF) --------------------
        # A virtual authenticator that supports PRF stands in for a phone's face or fingerprint.
        cdp = ctx.new_cdp_session(pg)
        cdp.send('WebAuthn.enable', {'enableUI': False})
        cdp.send('WebAuthn.addVirtualAuthenticator', {'options': {
            'protocol': 'ctap2', 'ctap2Version': 'ctap2_1', 'transport': 'internal',
            'hasResidentKey': True, 'hasUserVerification': True, 'hasPrf': True,
            'isUserVerified': True, 'automaticPresenceSimulation': True}})
        pg.click('a[data-view=settings]'); pg.wait_for_selector('#pk-add')
        pg.fill('#pk-pass', 'demo passphrase 1'); pg.click('#pk-add')
        expect(pg.locator('#view')).to_contain_text('A passkey unlocks this wallet here')
        expect(pg.locator('#view')).to_contain_text('Passkey ready')
        kept = pg.evaluate("localStorage.getItem('devoid-web:passkey')")
        assert 'demo passphrase 1' not in kept, 'the passphrase is in storage in the clear'
        assert json.loads(kept)['cipher']['name'] == 'AES-256-GCM', kept
        pg.click('button:has-text("Lock now")')
        pg.click('.side-cta'); pg.wait_for_selector('#batch, .rcp')
        if not pg.locator('#batch').count():
            pg.click('[aria-label="How to add recipients"] button:has-text("Paste a list")'); pg.wait_for_selector('#batch')
        pg.fill('#batch', f'{mine},0.01,by passkey'); pg.click('text=Check recipients'); pg.wait_for_selector('.ledger')
        pg.click('#review'); pg.wait_for_selector('.sheet')
        expect(pg.locator('#pw')).to_be_visible()
        pg.click('#pk-unlock')  # the device gives back the passphrase it sealed
        expect(pg.locator('#lock-now')).to_be_visible(); expect(pg.locator('#pw')).to_have_count(0)
        pg.click('#confirm'); pg.wait_for_selector('#sent-total', timeout=60_000)
        shot(pg, '05-passkey')
        # A passkey is this browser's: deleting the wallet takes it with everything else (below).

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

        # ---- installable: its own manifest, its own copy of the app, and it opens with no network ------
        ctx = b.new_context(viewport={'width': 1200, 'height': 900}, service_workers='allow')
        pg = ctx.new_page(); watch(pg)
        pg.goto(base + '/app/')
        manifest = pg.evaluate("async () => { const r = await fetch(document.querySelector('link[rel=manifest]').href); return { type: r.headers.get('content-type'), body: await r.json() }; }")
        assert manifest['type'].startswith('application/manifest+json'), manifest['type']
        assert manifest['body']['display'] == 'standalone' and manifest['body']['start_url'] == './', manifest['body']
        sizes = {i['sizes'] for i in manifest['body']['icons']}
        assert {'192x192', '512x512'} <= sizes and any(i['purpose'] == 'maskable' for i in manifest['body']['icons']), sizes
        for i in manifest['body']['icons']:
            assert pg.evaluate("(src) => fetch(src).then((r) => r.ok)", i['src']), i['src']
        pg.evaluate('() => navigator.serviceWorker.ready')
        kept = pg.evaluate("async () => { const [k] = await caches.keys(); return [k, (await (await caches.open(k)).keys()).length]; }")
        assert kept[0].startswith('devoid-app-') and kept[1] > 20, kept
        # The 15 MB engine is not downloaded until it is wanted; the shell is.
        assert not any(u.endswith('.wasm') for u in pg.evaluate("async () => { const [k] = await caches.keys(); return (await (await caches.open(k)).keys()).map((r) => r.url); }"))
        pg.reload(); pg.wait_for_selector('.form-card')
        assert pg.evaluate('Boolean(navigator.serviceWorker.controller)'), 'the service worker is not serving the app'
        ctx.set_offline(True)
        pg.reload(); pg.wait_for_selector('.form-card')  # the whole app, with no connection at all
        check(pg, '06-offline')
        ctx.set_offline(False)
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
        assert proof['ok'] and proof['result']['orchardActions'] >= 1 and proof['result']['saplingOutputs'] >= 1 and proof['result']['builtAt'] > 1_700_000_000, proof
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
