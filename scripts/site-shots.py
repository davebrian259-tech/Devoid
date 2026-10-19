# Captures the product images for the landing page (site/img) from the real UI running on the
# simulated engine, once in the light theme and once in the dark, and the README's screens
# (docs/img, light only). The demo banner is hidden for these shots; both caption them as demo data.
#
#   DEVOID_CHROMIUM=/path/to/chrome python3 scripts/site-shots.py
import subprocess, os, re, tempfile
from playwright.sync_api import sync_playwright

HIDE = '.band.sim { display: none !important; } .toast { display: none !important; }'
TEAM = ['Alice', 'Bilal', 'Chen', 'Dara', 'Emeka', 'Farah', 'Goran', 'Hana', 'Ivo', 'Jun', 'Kofi', 'Lena']


def start_server():
    srv = subprocess.Popen(['node', 'server/index.mjs', '--demo', '--port=0'], env=dict(os.environ, DEVOID_HOME=tempfile.mkdtemp()), stdout=subprocess.PIPE, text=True)
    for _ in range(50):
        m = re.search(r'Open:\s+(\S+)', srv.stdout.readline())
        if m: return srv, m.group(1)
    srv.terminate(); raise SystemExit('server did not start')


def capture(b, scheme, suffix, readme=False):
    srv, url = start_server()
    try:
        # bypass_csp only so the capture can hide the demo banner; the app itself never needs it
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=2, bypass_csp=True, color_scheme=scheme)
        pg = ctx.new_page()
        pg.goto(url)
        pg.fill('#p1', 'correct horse battery'); pg.fill('#p2', 'correct horse battery'); pg.click('text=Create wallet')
        pg.wait_for_selector('.phrase span')
        words = [s.inner_text() for s in pg.query_selector_all('.phrase span')]
        pg.check('#wrote'); pg.click('text=Continue')
        for inp in pg.query_selector_all('input[data-word]'): inp.fill(words[int(inp.get_attribute('data-word')) - 1])
        pg.click('text=Open my wallet'); pg.wait_for_selector('.poolbar')
        pg.add_style_tag(content=HIDE)

        pg.click('a[data-view=receive]'); pg.wait_for_selector('svg.qr'); ua = pg.inner_text('#addr')
        addrs = [ua]
        for _ in range(4):
            pg.click('button:has-text("New address")'); pg.wait_for_function(f"document.getElementById('addr').innerText !== {addrs[-1]!r}")
            addrs.append(pg.inner_text('#addr'))
        pg.click('a[data-view=contacts]')
        for name, addr in zip(['Ada Lovelace', 'Grace Hopper', 'Hal Finney', 'Mira Osei', 'Zooko W'], addrs):
            pg.click('#add-contact'); pg.fill('#c-name', name); pg.fill('#c-addr', addr); pg.click('#c-save')
            pg.wait_for_selector(f'.item.contact:has-text("{name}")')

        if readme:  # the Send screen, one card per recipient, with the live summary beside it
            pg.click('a[data-view=send]'); pg.wait_for_selector('[data-rcp="1"]')
            people = [('Ada Lovelace', addrs[1], '0.25', 'October grant'), ('Grace Hopper', addrs[2], '0.40', 'Design review'), ('Hal Finney', addrs[3], '0.15', '')]
            for i, (name, addr, amount, memo) in enumerate(people):
                if i: pg.click('#add-recipient')
                c = f'[data-rcp="{i + 1}"]'
                pg.fill(f'{c} [data-field=address]', addr); pg.fill(f'{c} input[data-field=amount]', amount)
                pg.fill(f'{c} [data-field=label]', name); pg.fill(f'{c} [data-field=memo]', memo)
            pg.wait_for_selector('[data-rcp="3"] .rcp-kind .pill'); pg.wait_for_timeout(800)
            pg.set_viewport_size({'width': 1440, 'height': 1180}); pg.evaluate('document.activeElement.blur(); scrollTo(0, 0)')
            pg.mouse.move(1430, 1170); pg.wait_for_timeout(300)
            pg.screenshot(path='docs/img/send.jpg', type='jpeg', quality=82)
            pg.set_viewport_size({'width': 1440, 'height': 900})

        # one sent batch so the overview has history
        pg.click('a[data-view=send]')
        pg.click('[aria-label="How to add recipients"] button:has-text("Paste a list")')
        rows = ['address,amount,memo,label'] + [f'{ua},{0.05 + i * 0.01:.2f},October grant,{n}' for i, n in enumerate(TEAM)]
        pg.fill('#batch', '\n'.join(rows)); pg.click('text=Check recipients'); pg.wait_for_selector('.ledger')
        pg.click('#review'); pg.wait_for_selector('.sheet'); pg.wait_for_timeout(300)
        pg.locator('.sheet > .card').first.screenshot(path=f'site/img/review{suffix}.jpg', type='jpeg', quality=90)
        pg.fill('#pw', 'correct horse battery'); pg.click('#confirm'); pg.wait_for_selector('#sent-total', timeout=120_000)  # only on the finished screen

        if readme:
            pg.click('a[data-view=activity]'); pg.wait_for_selector('#view :text("Sent to")'); pg.mouse.move(1430, 890)
            pg.keyboard.press('.'); pg.wait_for_timeout(600)  # show the amounts
            pg.screenshot(path='docs/img/activity.jpg', type='jpeg', quality=82)
            pg.keyboard.press('.'); pg.wait_for_timeout(300)
        pg.click('a[data-view=home]'); pg.wait_for_selector('.poolbar'); pg.wait_for_selector('.item:has-text("Sent to")')
        pg.click('#syncbtn'); pg.wait_for_function("!document.querySelector('#syncbtn .spin')"); pg.click('.redact'); pg.wait_for_timeout(600)
        pg.mouse.move(1000, 600)
        pg.screenshot(path=f'site/img/overview{suffix}.jpg', type='jpeg', quality=88)

        phone = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, bypass_csp=True, color_scheme=scheme)
        ph = phone.new_page()
        ph.goto(url.split('#')[0] + '#home')
        ph.evaluate(f"sessionStorage.setItem('devoid-token', '{url.split('token=')[1]}')"); ph.reload()
        ph.wait_for_selector('.poolbar'); ph.add_style_tag(content=HIDE); ph.click('.redact'); ph.wait_for_timeout(600)
        ph.screenshot(path=f'site/img/phone{suffix}.jpg', type='jpeg', quality=88)
        ctx.close(); phone.close()
    finally:
        srv.terminate()


os.makedirs('site/img', exist_ok=True); os.makedirs('docs/img', exist_ok=True)
with sync_playwright() as p:
    exe = os.environ.get('DEVOID_CHROMIUM')
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    capture(b, 'light', '', readme=True)
    capture(b, 'dark', '-dark')
    b.close()
print('shots written to site/img and docs/img')
