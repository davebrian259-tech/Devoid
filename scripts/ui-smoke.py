# UI smoke test: drives the real UI against the simulated engine, through every screen and feature,
# and saves screenshots to ./shots. Fails on any console error or broken step.
#
#   python3 scripts/ui-smoke.py
#   DEVOID_CHROMIUM=/path/to/chrome python3 scripts/ui-smoke.py   # use an installed Chromium
import subprocess, os, re, sys, tempfile, glob
from playwright.sync_api import sync_playwright, expect

home = tempfile.mkdtemp()
env = dict(os.environ, DEVOID_HOME=home)
srv = subprocess.Popen(['node', 'server/index.mjs', '--demo', '--port=0'], env=env, stdout=subprocess.PIPE, text=True)
url = None
for _ in range(50):
    m = re.search(r'Open:\s+(\S+)', srv.stdout.readline())
    if m: url = m.group(1); break
assert url, 'server did not start'
os.makedirs('shots', exist_ok=True)
for old in glob.glob('shots/*.png'): os.remove(old)
errors = []

def shot(pg, name, full=False):
    pg.wait_for_timeout(250)
    # A missing value rendered as text is a bug even when every step still passes.
    text = pg.evaluate('document.body.innerText')
    for leak in ('null', 'undefined', 'NaN', '[object Object]'):
        assert not re.search(r'(?<![\w-])' + re.escape(leak) + r'(?![\w-])', text), f'{name}: "{leak}" is showing on screen'
    pg.screenshot(path=f'shots/{name}.png', full_page=full)

def nav(pg, view):
    pg.click(f'a[data-view={view}]')

try:
    with sync_playwright() as p:
        exe = os.environ.get('DEVOID_CHROMIUM')
        b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        pg = b.new_page(viewport={'width': 1366, 'height': 900}, accept_downloads=True)
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(url)

        # ---- welcome, create, back up, verify ---------------------------------------------------
        pg.wait_for_selector('.hero')
        shot(pg, '01-welcome')
        pg.fill('#p1', 'correct horse battery'); pg.fill('#p2', 'correct horse battery')
        pg.click('text=Create wallet')
        pg.wait_for_selector('.phrase span')
        words = [s.inner_text() for s in pg.query_selector_all('.phrase span')]
        assert len(words) == 24, words
        shot(pg, '02-phrase')
        pg.check('#wrote'); pg.click('text=Continue')
        first = pg.query_selector('input[data-word]')
        first.fill('wrongword'); pg.click('text=Open my wallet')
        expect(pg.locator('.note.err')).to_be_visible()  # a wrong word is caught
        for inp in pg.query_selector_all('input[data-word]'):
            inp.fill(words[int(inp.get_attribute('data-word')) - 1])
        pg.click('text=Open my wallet')

        # ---- overview: balances stay hidden until asked -------------------------------------------
        pg.wait_for_selector('.redact')
        expect(pg.locator('.redact .figure')).not_to_have_text('—')
        expect(pg.locator('.redact')).to_have_attribute('aria-pressed', 'false')
        assert 'reveal' not in (pg.get_attribute('body', 'class') or '')
        pg.wait_for_selector('.poolbar')
        shot(pg, '03-home-hidden')
        pg.click('.redact')
        # The bar slides away over 0.28s; wait for the state and the paint, or this proves nothing.
        expect(pg.locator('.redact')).to_have_attribute('aria-pressed', 'true')
        expect(pg.locator('#eye')).to_have_attribute('aria-pressed', 'true')
        pg.wait_for_timeout(450)
        shot(pg, '04-home-revealed')

        # ---- receive and a ZIP 321 request ---------------------------------------------------------
        nav(pg, 'receive'); pg.wait_for_selector('svg.qr')
        shielded = pg.inner_text('#addr')
        assert shielded.startswith('u'), shielded
        shot(pg, '05-receive')
        pg.click('.seg button:has-text("Sapling")'); sapling = pg.inner_text('#addr')
        assert sapling.startswith('zs'), sapling
        pg.click('.seg button:has-text("Shielded")')
        pg.click('#request'); pg.fill('#req-amount', '0.25'); pg.fill('#req-memo', 'Invoice 42')
        uri = pg.inner_text('#req-uri')
        assert uri.startswith(f'zcash:{shielded}?amount=0.25&memo='), uri
        shot(pg, '06-request')
        pg.keyboard.press('Escape')

        # ---- contacts --------------------------------------------------------------------------------
        nav(pg, 'contacts')
        for name, addr in [('Ada Lovelace', shielded), ('Grace Hopper', sapling)]:
            pg.click('#add-contact'); pg.fill('#c-name', name); pg.fill('#c-addr', addr); pg.click('#c-save')
            expect(pg.locator('.item.contact', has_text=name)).to_be_visible()
        pg.click('#add-contact'); pg.fill('#c-name', 'Nobody'); pg.fill('#c-addr', 'not-an-address'); pg.click('#c-save')
        expect(pg.locator('dialog .note.err')).to_be_visible()  # bad addresses never get saved
        pg.keyboard.press('Escape')
        shot(pg, '07-contacts')

        # ---- send: contacts into a batch, tools, a big list, review, send, receipt ---------------
        nav(pg, 'send')
        pg.click('.toolbar button:has-text("Contacts")')
        for cb in pg.query_selector_all('dialog .pick input[type=checkbox]'): cb.check()
        pg.click('dialog button:has-text("Add 2 to batch")')
        pg.wait_for_selector('.ledger')
        pg.click('button:has-text("One amount for all")'); pg.fill('dialog input', '0.01'); pg.click('dialog button:has-text("Apply")')
        expect(pg.locator('.ledger td.amt').first).to_have_text('0.01')
        expect(pg.locator('#review')).to_be_enabled()

        rows = ['address,amount,memo'] + [f'{shielded},0.01,payment {i}' for i in range(30)] + ['bad-address,1,']
        pg.fill('#batch', '\n'.join(rows))
        pg.click('text=Check recipients'); pg.wait_for_selector('.ledger tr.bad')
        expect(pg.locator('#review')).to_be_disabled()  # a bad row blocks the review
        expect(pg.locator('.big-count')).to_have_text('30')
        shot(pg, '08-send', full=True)
        pg.click('button:has-text("Remove 1 with problems")')
        expect(pg.locator('.ledger tr.bad')).to_have_count(0)
        expect(pg.locator('#review')).to_be_enabled()

        pg.click('.toolbar button:has-text("Save as list")'); pg.fill('dialog input', 'October payroll'); pg.click('dialog button:has-text("Save list")')
        expect(pg.locator('.toast')).to_contain_text('List saved')

        pg.click('#review'); pg.wait_for_selector('.sheet')
        expect(pg.locator('#review-total')).to_contain_text('0.30')
        shot(pg, '09-review', full=True)
        pg.fill('#pw', 'wrong-passphrase'); pg.click('#confirm')
        expect(pg.locator('.note.err')).to_contain_text('passphrase')
        pg.fill('#pw', 'correct horse battery'); pg.click('#confirm')
        pg.wait_for_selector('text=Broadcast', timeout=120_000)
        expect(pg.locator('.txid')).to_have_count(2)
        shot(pg, '10-sent')
        with pg.expect_download() as d: pg.click('#receipt')
        receipt = open(d.value.path()).read().strip().split('\n')
        assert receipt[0].startswith('line,address,label,amount'), receipt[0]
        assert len(receipt) == 31 and all(',sent,' in r for r in receipt[1:]), receipt[:3]

        # ---- activity ----------------------------------------------------------------------------------
        nav(pg, 'activity'); pg.wait_for_selector('.tx')
        pg.click('.tx > button >> nth=0'); pg.wait_for_selector('.tx .detail:not([hidden]) .kv')
        shot(pg, '11-activity', full=True)
        pg.click('.chip:has-text("Received")')
        expect(pg.locator('.tx')).to_have_count(1)
        pg.click('.chip:has-text("All")')
        with pg.expect_download() as d: pg.click('button:has-text("Export CSV")')
        csv = open(d.value.path()).read().strip().split('\n')
        assert csv[0].startswith('date,type,status'), csv[0]
        assert len(csv) >= 4, csv

        # ---- lists, settings, dark mode -------------------------------------------------------------
        nav(pg, 'lists'); expect(pg.locator('.tpl', has_text='October payroll')).to_be_visible()
        expect(pg.locator('.tpl .stats b').first).to_have_text('30')
        shot(pg, '12-lists')
        nav(pg, 'settings'); pg.wait_for_selector('#shield')
        shot(pg, '13-settings', full=True)
        pg.click('.seg button:has-text("Dark")')
        assert pg.get_attribute('html', 'data-theme') == 'dark'
        nav(pg, 'home'); pg.wait_for_selector('.poolbar')
        shot(pg, '14-home-dark')
        nav(pg, 'send'); pg.wait_for_selector('#batch')
        pg.fill('#batch', '\n'.join(rows[:6])); pg.click('text=Check recipients'); pg.wait_for_selector('.ledger')
        pg.wait_for_timeout(300)
        # The change from the batch above may still be confirming. Either way the summary and the
        # engine must agree: an enabled Review reaches the sheet, a disabled one says why.
        if pg.is_enabled('#review'):
            pg.click('#review'); pg.wait_for_selector('.sheet')
            pg.click('button:has-text("Back to recipients")'); pg.wait_for_selector('#batch')
        else:
            expect(pg.locator('aside .note.err')).to_contain_text('Not enough funds')
        shot(pg, '15-send-dark', full=True)
        nav(pg, 'settings'); pg.click('.seg button:has-text("Light")')

        # ---- phone ----------------------------------------------------------------------------------------
        pg.set_viewport_size({'width': 390, 'height': 844})
        pg.click('a[data-tab=home]'); pg.wait_for_selector('.poolbar')
        expect(pg.locator('.tabbar')).to_be_visible()
        expect(pg.locator('.side')).to_be_hidden()
        shot(pg, '16-phone-home', full=True)
        pg.click('a[data-tab=send]'); pg.wait_for_selector('#batch'); pg.click('text=Check recipients'); pg.wait_for_selector('.ledger')
        shot(pg, '17-phone-send', full=True)
        pg.click('a[data-tab=more]'); expect(pg.locator('.menu-list a')).to_have_count(3)
        pg.click('.menu-list a:has-text("Contacts")'); expect(pg.locator('a[data-tab=more]')).to_have_attribute('aria-current', 'page')
        pg.click('a[data-tab=receive]'); pg.wait_for_selector('svg.qr')
        shot(pg, '18-phone-receive', full=True)
        b.close()
finally:
    srv.terminate()

print('console errors:', errors)
assert not errors, errors
print('ui smoke: all steps passed')
