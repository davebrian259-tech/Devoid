# UI smoke test: drives the real UI against the simulated engine and saves screenshots to ./shots
import subprocess, os, re, sys, tempfile, time, json
from playwright.sync_api import sync_playwright, expect
home = tempfile.mkdtemp()
env = dict(os.environ, DEVOID_HOME=home)
srv = subprocess.Popen(['node', 'server/index.mjs', '--demo', '--port=0'], env=env, stdout=subprocess.PIPE, text=True)
url = None
for _ in range(50):
    line = srv.stdout.readline()
    m = re.search(r'Open:\s+(\S+)', line)
    if m: url = m.group(1); break
assert url, 'server did not start'
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1280, 'height': 900})
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(url)
        pg.wait_for_selector('#p1')
        pg.screenshot(path='shots/01-create.png')
        pg.fill('#p1', 'correct horse battery'); pg.fill('#p2', 'correct horse battery')
        pg.click('text=Create wallet')
        pg.wait_for_selector('.phrase span')
        assert pg.locator('.phrase span').count() == 24
        pg.screenshot(path='shots/02-phrase.png')
        pg.check('#wrote'); pg.click('text=Open wallet')
        pg.wait_for_selector('.redact')
        expect(pg.locator('.redact .figure')).not_to_have_text('—')
        pg.screenshot(path='shots/03-home-hidden.png')
        pg.click('.redact'); pg.screenshot(path='shots/04-home-revealed.png')
        # receive
        pg.click('a[data-view=receive]'); pg.wait_for_selector('svg.qr'); pg.screenshot(path='shots/05-receive.png', full_page=True)
        sh = pg.locator('.addr-text').first.inner_text()
        # batch
        pg.click('a[data-view=send]')
        rows = ['address,amount,memo'] + [f'{sh},0.01,payment {i}' for i in range(30)] + ['bad-address,1,']
        pg.fill('#batch', '\n'.join(rows))
        pg.click('text=Check recipients'); pg.wait_for_selector('.ledger')
        pg.screenshot(path='shots/06-ledger.png', full_page=True)
        assert pg.locator('tr.bad').count() == 1
        pg.click('text=Remove rows with problems'); expect(pg.locator('tr.bad')).to_have_count(0)
        pg.click('text=Review payment'); pg.wait_for_selector('.receipt')
        pg.screenshot(path='shots/07-review.png', full_page=True)
        pg.fill('#pw', 'correct horse battery'); pg.click('text=Send 30 payments')
        pg.wait_for_selector('.note.ok >> text=Sent', timeout=120000)
        pg.screenshot(path='shots/08-sent.png', full_page=True)
        pg.click('a[data-view=activity]'); pg.wait_for_selector('.tx'); pg.click('.tx > button >> nth=0')
        pg.screenshot(path='shots/09-activity.png', full_page=True)
        pg.click('a[data-view=settings]'); pg.wait_for_selector('text=Network connection'); pg.screenshot(path='shots/10-settings.png', full_page=True)
        pg.set_viewport_size({'width': 390, 'height': 800}); pg.click('a[data-view=send]'); pg.screenshot(path='shots/11-mobile.png', full_page=True)
        b.close()
finally:
    srv.terminate()
print('console errors:', errors)
sys.exit(1 if errors else 0)
