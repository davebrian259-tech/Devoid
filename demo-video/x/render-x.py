# Renders the X artboards in x-assets.html to PNGs at twice their size (crisp on retina screens),
# plus a 1x copy of each post for X's 1600x900 upload.  python3 demo-video/x/render-x.py
import os
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'output', 'x')
os.makedirs(OUT, exist_ok=True)
BOARDS = [('profile', 'x-profile.png'), ('header', 'x-header.png'), ('launch', 'x-post-launch.png'), ('why', 'x-post-why.png')]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('DEVOID_CHROMIUM') or None)
    for scale in (1, 2):
        pg = b.new_page(viewport={'width': 1800, 'height': 1200}, device_scale_factor=scale)
        pg.goto('file://' + os.path.join(HERE, 'x-assets.html'))
        pg.evaluate('document.fonts.ready'); pg.wait_for_timeout(400)
        for board, name in BOARDS:
            path = os.path.join(OUT, name if scale == 1 else name.replace('.png', '@2x.png'))
            pg.locator(f'#{board}').screenshot(path=path)
            print(os.path.relpath(path, os.path.dirname(HERE)))
        pg.close()
    b.close()
