# Layout check for the landing site (site/): loads every page at phone-to-desktop widths in both
# themes and fails on an overlap, a box that clips its own content, sideways scrolling, a picture
# covering text, a missing image or a console error. The app has its own checks (ui-smoke.py,
# web-smoke.py); this one guards the pages around it.
#
#   python3 scripts/site-smoke.py
#   DEVOID_CHROMIUM=/path/to/chrome python3 scripts/site-smoke.py   # use an installed Chromium
import os, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from site_server import build_and_serve  # noqa: E402  (serves dist/ the way Cloudflare does)

PAGES = ['/', '/privacy.html', '/404.html']
WIDTHS = [1440, 1180, 980, 760, 560, 390, 320]
CHECK = open(os.path.join(HERE, 'overlap.js')).read()
# An image that tried and failed leaves an empty box, so no layout check downstream means anything.
# One still waiting is fine: every image on these pages reserves its space with width and height.
BROKEN = '[...document.images].filter((i) => i.complete && !i.naturalWidth).map((i) => i.currentSrc || i.src)'

srv, base = build_and_serve()

errors, checked = [], 0
try:
    with sync_playwright() as p:
        exe = os.environ.get('DEVOID_CHROMIUM')
        b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        for scheme in ('light', 'dark'):
            pg = b.new_page(viewport={'width': WIDTHS[0], 'height': 1000}, color_scheme=scheme)
            pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            pg.on('pageerror', lambda e: errors.append(str(e)))
            for page in PAGES:
                pg.goto(base + page, wait_until='load')
                for width in WIDTHS:
                    pg.set_viewport_size({'width': width, 'height': 1000})
                    broken = pg.evaluate(BROKEN)
                    assert not broken, f'{page} ({scheme}): image did not load: {broken}'
                    problems = pg.evaluate(CHECK)
                    assert not problems, f'{page} at {width}px ({scheme}):\n  ' + '\n  '.join(problems)
                    checked += 1
            # Prove the check on the page it was written for: the hero's caption used to sit under
            # the phone mockup, and a mockup nudged down covers it even now that it is in the flow.
            pg.goto(base + '/', wait_until='load')
            pg.set_viewport_size({'width': 390, 'height': 1000})
            pg.evaluate("() => { const cap = document.querySelector('.stage figcaption');"
                        " document.querySelector('.shots').append(cap);"
                        " cap.style.cssText = 'position:absolute;left:0;bottom:0;margin:0'; }")
            assert any('figcaption' in x for x in pg.evaluate(CHECK)), 'the check no longer catches a caption under the mockup'
            pg.goto(base + '/', wait_until='load')
            pg.evaluate("() => { document.querySelector('.phone').style.transform = 'translateY(70px)'; }")  # the CSP forbids a style tag
            assert any('figcaption' in x for x in pg.evaluate(CHECK)), 'the check no longer catches a mockup over text'
            pg.close()
        b.close()
finally:
    srv.shutdown()

assert not errors, 'console errors:\n  ' + '\n  '.join(errors)
print(f'site layout clean: {len(PAGES)} pages, {len(WIDTHS)} widths, light and dark ({checked} checks)')
