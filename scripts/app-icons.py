# Writes the web app's home-screen icons from ui/mark.svg, so they stay in step with the brand.
# Three shapes: the mark as it is (for browsers that draw their own frame), a full-bleed maskable
# one with the mark inside the safe circle (Android), and the Apple touch icon.
#
#   DEVOID_CHROMIUM=/path/to/chrome python3 scripts/app-icons.py
import os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK = open(os.path.join(ROOT, 'ui', 'mark.svg')).read()
BG = '#0f1115'  # the mark's own square, so the padded icons extend it to the edges

# name, size, how much of the icon the mark fills (1 = edge to edge), rounded corners
ICONS = [
    ('icon-192.png', 192, 1.0, True),
    ('icon-512.png', 512, 1.0, True),
    ('icon-maskable-512.png', 512, 0.62, False),  # Android masks it; keep the mark in the safe circle
    ('apple-touch-icon.png', 180, 0.78, False),   # iOS rounds it itself
]

page_html = """<!doctype html><meta charset=utf-8><style>
  html, body { margin: 0; background: %s; }
  body { width: %dpx; height: %dpx; display: grid; place-items: center; %s }
  svg { width: %dpx; height: %dpx; display: block; }
</style>%s"""

with sync_playwright() as p:
    exe = os.environ.get('DEVOID_CHROMIUM')
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    for name, size, fill, bare in ICONS:
        mark = MARK if bare else MARK.replace('<rect width="32" height="32" rx="9" fill="#0f1115"/>', '')
        inner = round(size * fill)
        pg = b.new_page(viewport={'width': size, 'height': size})
        pg.set_content(page_html % (BG, size, size, '' if bare else '', inner, inner, mark))
        pg.screenshot(path=os.path.join(ROOT, 'ui', name), omit_background=False)
        pg.close()
        print(f'ui/{name}  {size}x{size}')
    b.close()
