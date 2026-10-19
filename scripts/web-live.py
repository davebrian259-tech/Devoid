# Live test of the real web wallet, through the UI, against the Zcash testnet: builds dist/,
# serves it with its production headers, and in Chromium creates a testnet wallet (the engine
# compiled to WebAssembly, talking gRPC-web to lightwalletd), backs up and checks the phrase, syncs
# to the chain tip, shows a receiving address, gets an exact fee quote refused for lack of funds,
# reloads to prove the wallet persisted, and deletes it; then does the same on mainnet (no funds
# needed: it syncs to the mainnet tip and shows a mainnet address). Needs the network, not in CI.
#
#   python3 scripts/web-live.py
#   DEVOID_CHROMIUM=/path/to/chrome python3 scripts/web-live.py
#
# Behind a proxy that re-signs TLS (some sandboxes), set HTTPS_PROXY and DEVOID_INSECURE_TLS=1:
# Chromium then uses the proxy and accepts its certificates. Never set that anywhere else.
import os, re, sys, glob
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from site_server import ROOT, build_and_serve

srv, base = build_and_serve()
os.makedirs('shots', exist_ok=True)
for old in glob.glob('shots/live-*.png'): os.remove(old)
errors = []
LAYOUT_CHECK = open(os.path.join(ROOT, 'scripts', 'overlap.js')).read()
PASS = 'live testnet passphrase'


def shot(pg, name, full=False):
    pg.wait_for_timeout(300)
    problems = pg.evaluate(LAYOUT_CHECK)
    assert not problems, f'{name}: layout problems:\n  ' + '\n  '.join(problems)
    pg.screenshot(path=f'shots/live-{name}.png', full_page=full)


def steps(pg):
    # ---- create a real testnet wallet ---------------------------------------------------------------
    pg.goto(base + '/app/' + (f"?log={os.environ['DEVOID_LOG']}" if os.environ.get('DEVOID_LOG') else ''))
    pg.wait_for_selector('#p1')
    expect(pg.locator('.seg button:has-text("Real wallet")')).to_have_attribute('aria-pressed', 'true')
    expect(pg.locator('[aria-label=Network] button:has-text("Testnet")')).to_have_attribute('aria-pressed', 'true')
    expect(pg.locator('.seg button:has-text("Restore")')).to_have_count(0)
    shot(pg, '01-welcome')
    pg.fill('#p1', PASS); pg.fill('#p2', PASS); pg.click('text=Create wallet')
    pg.wait_for_selector('.phrase span')
    words = [s.inner_text() for s in pg.query_selector_all('.phrase span')]
    assert len(words) == 24, words
    expect(pg.locator('.note.warn')).to_contain_text('Write these words on paper')
    shot(pg, '02-phrase')
    pg.check('#wrote'); pg.click('text=Continue')
    for inp in pg.query_selector_all('input[data-word]'): inp.fill(words[int(inp.get_attribute('data-word')) - 1])
    pg.click('text=Open my wallet')

    # ---- synced to the tip ------------------------------------------------------------------------------
    pg.wait_for_selector('.side .nav')  # a new wallet has no funds, so no pool bar yet
    expect(pg.locator('.band.testnet')).to_contain_text('Testnet wallet in your browser')
    expect(pg.locator('#wc-sync')).to_contain_text('Synced', timeout=180_000)
    height = int(re.sub(r'\D', '', pg.inner_text('#wc-sync')))
    assert height > 4_000_000, height
    print(f'synced to testnet block {height:,}')
    shot(pg, '03-home')

    # ---- a real address --------------------------------------------------------------------------------
    pg.click('a[data-view=receive]'); pg.wait_for_selector('svg.qr')
    addr = pg.inner_text('#addr')
    assert addr.startswith('utest1') and len(addr) > 100, addr
    shot(pg, '04-receive')

    # ---- an exact quote, refused because the wallet is empty ------------------------------------
    pg.click('a[data-view=send]'); pg.wait_for_selector('#batch')
    pg.fill('#batch', f'address,amount,memo\n{addr},0.001,live check')
    pg.click('text=Check recipients'); pg.wait_for_selector('.ledger')
    if pg.is_enabled('#review'):
        pg.click('#review')
    expect(pg.locator('.note.err, .note.warn').first).to_contain_text('funds', timeout=60_000)
    shot(pg, '05-send', full=True)

    # ---- still there after a reload, then deleted ---------------------------------------------------
    pg.reload(); pg.wait_for_selector('.side .nav')
    pg.click('a[data-view=settings]'); pg.wait_for_selector('text=Delete this wallet')
    expect(pg.locator('#view')).to_contain_text('zcash-testnet.chainsafe.dev')
    shot(pg, '06-settings', full=True)
    pg.click('button:has-text("Delete this wallet")'); pg.click('dialog button:has-text("Delete wallet")')
    pg.wait_for_selector('#p1')
    pg.reload(); pg.wait_for_selector('#p1')  # gone for good

    # ---- mainnet: the same engine against the real chain (no funds needed) -----------------------------
    pg.click('[aria-label=Network] button:has-text("Mainnet")')
    pg.fill('#p1', PASS); pg.fill('#p2', PASS); pg.click('text=Create wallet')
    expect(pg.locator('.note.err')).to_contain_text('real ZEC')  # refused until the box is ticked
    pg.check('#mainnet-ack'); pg.click('text=Create wallet')
    pg.wait_for_selector('.phrase span')
    words = [s.inner_text() for s in pg.query_selector_all('.phrase span')]
    pg.check('#wrote'); pg.click('text=Continue')
    for inp in pg.query_selector_all('input[data-word]'): inp.fill(words[int(inp.get_attribute('data-word')) - 1])
    pg.click('text=Open my wallet')
    pg.wait_for_selector('.side .nav')
    expect(pg.locator('#wc-sync')).to_contain_text('Synced', timeout=180_000)
    height = int(re.sub(r'\D', '', pg.inner_text('#wc-sync')))
    assert 3_000_000 < height < 4_000_000, height  # mainnet heights, not testnet ones
    expect(pg.locator('.top .net')).to_contain_text('Mainnet')
    print(f'mainnet wallet synced to block {height:,}')
    pg.click('a[data-view=receive]'); pg.wait_for_selector('svg.qr')
    assert pg.inner_text('#addr').startswith('u1'), pg.inner_text('#addr')
    shot(pg, '07-mainnet-receive')
    pg.click('a[data-view=settings]'); pg.wait_for_selector('text=Delete this wallet')
    expect(pg.locator('#view')).to_contain_text('zcash-mainnet.chainsafe.dev')
    pg.click('button:has-text("Delete this wallet")'); pg.click('dialog button:has-text("Delete wallet")')
    pg.wait_for_selector('#p1')


try:
    with sync_playwright() as p:
        exe = os.environ.get('DEVOID_CHROMIUM')
        proxy = os.environ.get('HTTPS_PROXY') if os.environ.get('DEVOID_INSECURE_TLS') == '1' else None
        launch = {'executable_path': exe} if exe else {}
        if proxy: launch['proxy'] = {'server': proxy, 'bypass': '127.0.0.1'}
        b = p.chromium.launch(**launch)
        ctx = b.new_context(viewport={'width': 1366, 'height': 900}, ignore_https_errors=bool(proxy))
        pg = ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        # DEVOID_LOG=info (or debug) prints the engine's log as the test runs.
        if os.environ.get('DEVOID_LOG'): pg.on('console', lambda m: print('console:', m.text[:300], flush=True))
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.set_default_timeout(120_000)
        try:
            steps(pg)
        except Exception:
            pg.screenshot(path='shots/live-failed.png', full_page=True)  # where it stopped
            print('screen at failure: shots/live-failed.png')
            raise
        b.close()

finally:
    srv.shutdown()

print('console errors:', errors)
assert not errors, errors
print('web live: all steps passed')
