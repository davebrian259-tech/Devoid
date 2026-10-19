// Shared state, the API client and small DOM helpers used by every view.
import { icon } from './icons.js';
import { fmtZec } from './calc.js';

export const S = {
  token: null, status: null, balance: null, revealed: false, syncing: false,
  draft: { text: '', fundingPools: '' }, view: 'home', lists: null,
};

// The app registers its router here so views can navigate without importing app.js.
export const nav = { go: () => {}, refresh: async () => {}, paintSide: () => {}, setReveal: () => {} };

// The web version runs the whole wallet in this page (see local/backend.js); its index.html says so
// with <meta name="devoid-backend" content="web">. Otherwise the page talks to the local server.
export const WEB = document.querySelector('meta[name="devoid-backend"]')?.content === 'web';
// Web version: whether a real wallet may be created on mainnet. On since a batch from Devoid and a
// payment from this web engine were confirmed on mainnet (docs/STATUS.md); the backend enforces it too.
export const WEB_MAINNET = true;
let backend = null;

/** Web version only: deletes this browser's wallet, lists, contacts and settings. */
export async function webReset() {
  backend ??= import('./local/backend.js').then((m) => m.createBackend({ mainnet: WEB_MAINNET }));
  await (await backend).reset();
}

export async function api(path, body = {}) {
  if (WEB) {
    try {
      backend ??= import('./local/backend.js').then((m) => m.createBackend({ mainnet: WEB_MAINNET }));
      return await (await backend).call(path, body);
    } catch {
      backend = null;
      return { ok: false, error: { code: 'offline', message: 'The demo wallet could not start in this browser.' } };
    }
  }
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${S.token}` }, body: JSON.stringify(body) });
    return await r.json();
  } catch {
    return { ok: false, error: { code: 'offline', message: 'Devoid could not reach its local server. Check that it is still running.' } };
  }
}

/** Creates an element. Props starting with "on" become listeners; `style` is never set as an
 * attribute, because the CSP forbids inline styles. */
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'vars') for (const [n, x] of Object.entries(v)) e.style.setProperty(n, x);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

/** Replaces an element's children. Unlike the DOM method, null and false are skipped instead of
 * being printed as text, so conditional pieces can be passed inline. */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

export function btn(label, cls, onclick, ic, attrs = {}) {
  return h('button', { class: `btn ${cls ?? ''}`, type: 'button', onclick, ...attrs }, ic ? icon(ic) : null, label);
}

export function iconBtn(ic, label, onclick, attrs = {}) {
  return h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick, ...attrs }, icon(ic));
}

export function toast(msg, ic = 'check') {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', role: 'status' }, icon(ic), msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

export async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Copy is blocked here. Select the text and copy it yourself.', 'info'); }
}

/** Hands the viewer a file. Nothing leaves this computer. */
export function download(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: name, class: 'sr' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function note(kind, title, body, ic) {
  const icons = { ok: 'ok', warn: 'warn', err: 'alert', info: 'info', test: 'info' };
  return h('div', { class: `note ${kind}`, role: kind === 'err' ? 'alert' : null }, icon(ic ?? icons[kind] ?? 'info'), h('div', null, title ? h('b', null, title) : null, body));
}

export function errorNote(err) {
  if (!err) return null;
  const extra = err.details?.shortfallZat ? ` Short by ${fmtZec(err.details.shortfallZat)} ZEC.` : '';
  return note('err', err.message, extra || null);
}

/** A native modal dialog. `build(close)` returns its body. */
export function modal(title, build, { wide = false } = {}) {
  const d = h('dialog', { class: 'modal', 'aria-label': title });
  const close = () => { d.close(); d.remove(); };
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  d.append(h('div', { class: 'modal-body' }, h('div', { class: 'modal-head' }, h('h2', null, title), iconBtn('x', 'Close', close)), build(close)));
  if (wide) d.classList.add('wide');
  document.body.append(d); d.showModal();
  return { close, el: d };
}

export function confirmDialog(title, message, action, danger = false) {
  return new Promise((res) => {
    const m = modal(title, (close) => h('div', { class: 'stack' }, h('p', { class: 'muted' }, message),
      h('div', { class: 'row end' }, btn('Cancel', 'ghost sm', () => { close(); res(false); }), btn(action, `${danger ? 'danger' : ''} sm`, () => { close(); res(true); }))));
    m.el.addEventListener('close', () => res(false));
  });
}

export const when = (sec) => (sec ? new Date(sec * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not yet mined');
export const timeOf = (sec) => (sec ? new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
export const short = (a, n = 10) => (a && a.length > n * 2 + 3 ? `${a.slice(0, n)}…${a.slice(-n + 2)}` : a ?? '');
export const poolName = { ironwood: 'Ironwood', orchard: 'Orchard', sapling: 'Sapling', transparent: 'Transparent' };
/** Web version: which engine the wallet runs on ('real' or 'demo'). */
export const webEngine = () => (WEB ? S.status?.webEngine ?? null : null);
export const isTest = () => S.status?.wallet?.network === 'test';
export const unit = () => (isTest() ? 'TAZ' : 'ZEC');

/** Amount text that hides behind a redaction bar until the viewer reveals balances. */
export const sens = (text, cls = '') => h('span', { class: `sens ${cls}` }, text);

export function emptyState(ic, title, body, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'tile-ico' }, icon(ic)), h('h3', null, title), body ? h('p', { class: 'small' }, body) : null, action ?? null);
}

export async function loadLists() {
  const r = await api('/api/lists');
  if (r.ok) S.lists = { lists: r.result.lists ?? [], contacts: r.result.contacts ?? [] };
  nav.paintSide?.();
  return r;
}

export async function saveLists(patch) {
  const r = await api('/api/lists', patch);
  if (r.ok) S.lists = { lists: r.result.lists ?? [], contacts: r.result.contacts ?? [] };
  nav.paintSide?.();
  return r;
}

export function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* private window or blocked storage: the default is fine */ }
  return null;
}
