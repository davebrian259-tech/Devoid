// Theme: the viewer picks light or dark, or follows the system. The choice lives in this browser
// only. Every switch in the UI listens here, so they never disagree.
import { h, storage } from './lib.js';
import { icon } from './icons.js';

const system = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

/** "light", "dark", or null when following the system. */
export const themeChoice = () => { const v = storage('devoid-theme'); return v === 'light' || v === 'dark' ? v : null; };
/** What is on screen right now. */
export const effectiveTheme = () => themeChoice() ?? (system.matches ? 'dark' : 'light');

export function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  const color = effectiveTheme() === 'dark' ? '#0a0a0c' : '#f2f3f5';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = color; m.removeAttribute('media'); });
  listeners.forEach((fn) => fn());
}

export function setTheme(mode) { storage('devoid-theme', mode ?? null); applyTheme(mode); }
export function toggleTheme() { setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'); }
export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Keeps an element painted while it is on the page, and lets go once it has been removed.
// Views attach what they build in the same task, so by the next microtask a detached element has
// been removed for good.
function bind(el, paint) {
  let armed = false;
  queueMicrotask(() => { armed = true; });
  const off = onThemeChange(() => {
    if (el.isConnected) paint(); else if (armed) off();
  });
  paint();
}
system.addEventListener('change', () => { if (!themeChoice()) applyTheme(null); });

/** A two-way switch, sun and moon, with a sliding thumb. */
export function themeSwitch() {
  const el = h('div', { class: 'theme-switch', role: 'group', 'aria-label': 'Colour theme' });
  const paint = () => {
    const on = effectiveTheme(); el.dataset.on = on;
    for (const b of el.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === on));
  };
  el.append(...[['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']].map(([mode, ic, label]) =>
    h('button', { type: 'button', 'data-mode': mode, 'aria-label': `${label} theme`, title: `${label} theme (T)`, onclick: () => setTheme(mode) }, icon(ic))));
  bind(el, paint);
  return el;
}

/** One button that flips between light and dark. */
export function themeButton(cls = 'icon-btn') {
  const b = h('button', { class: `${cls} theme-btn`, type: 'button', onclick: toggleTheme });
  const paint = () => {
    const dark = effectiveTheme() === 'dark';
    b.replaceChildren(icon(dark ? 'sun' : 'moon'));
    b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme'); b.title = `${b.getAttribute('aria-label')} (T)`;
  };
  bind(b, paint);
  return b;
}
