// Devoid UI: boot, shell, router, sidebar, shortcuts, balance refresh. Each screen lives in views/.
import { S, nav, api, h, iconBtn, errorNote, isTest, storage, loadLists, fill, sens, unit, modal, WEB } from './lib.js';
import { icon, mark } from './icons.js';
import { fmtZec } from './calc.js';
import { applyTheme, themeChoice, themeSwitch, themeButton, toggleTheme } from './theme.js';
import { renderWelcome, renderGate } from './views/welcome.js';
import { viewHome } from './views/home.js';
import { viewSend } from './views/send.js';
import { viewReceive } from './views/receive.js';
import { viewActivity } from './views/activity.js';
import { viewLists } from './views/lists.js';
import { viewContacts } from './views/contacts.js';
import { viewSettings } from './views/settings.js';

const root = document.getElementById('app');

const VIEWS = {
  home: { label: 'Home', icon: 'home', title: 'Overview', key: 'h', render: viewHome },
  send: { label: 'Send', icon: 'send', title: 'Send to many', key: 's', sub: 'Paste or import a list. Devoid checks every address and shows what will be visible before anything is sent.', render: viewSend },
  receive: { label: 'Receive', icon: 'receive', title: 'Receive', key: 'r', sub: 'Share your shielded address, or a payment request with the amount filled in.', render: viewReceive },
  activity: { label: 'Activity', icon: 'activity', title: 'Activity', key: 'a', sub: 'Every payment in and out, with its status on chain.', render: viewActivity },
  lists: { label: 'Lists', icon: 'lists', title: 'Lists', key: 'l', sub: 'Reusable recipient lists for payroll, grants and DAO payouts. They stay on this computer.', render: viewLists },
  contacts: { label: 'Contacts', icon: 'contacts', title: 'Contacts', key: 'c', sub: 'People you pay often. Pick them straight into a batch.', render: viewContacts },
  settings: { label: 'Settings', icon: 'settings', title: 'Settings', key: ',', render: viewSettings },
  more: { label: 'More', icon: 'more', title: 'More', render: viewMore },
};
const GROUPS = [['Wallet', ['home', 'send', 'receive', 'activity']], ['Organise', ['lists', 'contacts']]];
const TABS = ['home', 'send', 'receive', 'activity', 'more'];
const narrow = matchMedia('(max-width: 1040px)');

(function loadToken() {
  if (WEB) { S.token = 'web'; return; } // no server to authenticate to
  const m = /token=([\w-]+)/.exec(location.hash);
  try {
    if (m) { sessionStorage.setItem('devoid-token', m[1]); history.replaceState(null, '', location.pathname); }
    S.token = m ? m[1] : sessionStorage.getItem('devoid-token');
  } catch { S.token = m ? m[1] : null; }
})();
applyTheme(themeChoice());

async function boot() {
  if (!S.token) {
    renderGate(root, 'Open Devoid from its link', h('p', { class: 'sub' }, 'The server prints a private link when it starts. Open that link in this browser; it carries the key that lets this page talk to your wallet.'));
    return;
  }
  const r = await api('/api/status');
  if (!r.ok) {
    renderGate(root, 'Cannot reach the wallet', h('div', { class: 'stack' }, errorNote(r.error), h('p', { class: 'sub' }, WEB ? 'Reload the page. If it keeps failing, this browser may be blocking scripts or storage.' : 'Restart the server and open the new link it prints.')));
    return;
  }
  S.status = r.result;
  if (!S.status.wallet.exists) return renderWelcome(root, () => boot());
  renderShell();
  loadLists();
  refresh(true);
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden) refresh(false); }, 20000);
}

const netBadge = () => (isTest()
  ? h('span', { class: 'net test', title: 'Testnet: play money with no value' }, h('span', { class: 'dot test' }), h('span', null, 'Testnet'))
  : h('span', { class: 'net', title: 'Mainnet: real ZEC' }, h('span', { class: 'dot' }), h('span', null, 'Mainnet')));

// ---- sidebar --------------------------------------------------------------------------------
function navLink(id, attr = 'data-view') {
  const v = VIEWS[id];
  return h('a', { href: `#${id}`, [attr]: id, 'data-tip': v.label, onclick: (e) => { e.preventDefault(); go(id); } },
    icon(v.icon), h('span', { class: 'lbl' }, v.label),
    attr === 'data-view' ? h('span', { class: 'tail' }, h('span', { class: 'badge', 'data-badge': id }), v.key ? h('kbd', { class: 'key' }, `G ${v.key === ',' ? ',' : v.key.toUpperCase()}`) : null) : null);
}

function newBatch() {
  // Never clear a batch that is sending or stopped halfway; those stay until dealt with.
  if (!S.sendFlow || S.sendFlow.step === 'done' || S.sendFlow.step === 'review') S.sendFlow = { step: 'compose' };
  go('send');
}

function setCollapsed(on) {
  storage('devoid-side', on ? 'collapsed' : null);
  paintCollapse();
}
function paintCollapse() {
  const on = narrow.matches || storage('devoid-side') === 'collapsed';
  document.querySelector('.app')?.classList.toggle('side-collapsed', on);
  const t = document.getElementById('side-toggle');
  if (t) { t.setAttribute('aria-expanded', String(!on)); t.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar'); t.title = `${t.getAttribute('aria-label')} ([)`; }
}

function sidebar() {
  const toggle = h('button', { class: 'side-icon', id: 'side-toggle', type: 'button', onclick: () => setCollapsed(storage('devoid-side') !== 'collapsed') }, icon('panel'));
  return h('aside', { class: 'side', 'aria-label': 'Sidebar' },
    h('div', { class: 'side-top' },
      h('a', { class: 'brand', href: '#home', 'data-tip': 'Home', onclick: (e) => { e.preventDefault(); go('home'); } }, mark(), h('span', { class: 'wordmark' }, 'devoid')),
      toggle),
    h('button', { class: 'side-cta', type: 'button', 'data-tip': 'New batch', onclick: newBatch }, icon('plus'), h('span', { class: 'lbl' }, 'New batch'), h('kbd', { class: 'key' }, 'N')),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, GROUPS.map(([label, ids]) => h('div', { class: 'nav-group' }, h('div', { class: 'nav-label' }, label), ids.map((id) => navLink(id))))),
    h('div', { class: 'side-foot' },
      h('button', { class: 'wallet-card', type: 'button', 'data-tip': isTest() ? 'Testnet wallet' : 'Mainnet wallet', onclick: () => go('home') },
        h('span', { class: 'wc-top' }, h('span', { class: `dot ${isTest() ? 'test' : ''}` }), h('b', null, isTest() ? 'Testnet' : 'Mainnet'),
          h('span', { class: `pill ${S.status.simulated ? 'public' : 'ok'}` }, S.status.simulated ? 'Demo' : S.status.engineVerified ? 'Verified' : 'Engine')),
        h('span', { class: 'wc-bal', id: 'wc-bal' }), h('span', { class: 'wc-sync', id: 'wc-sync' })),
      h('div', { class: 'nav' }, navLink('settings')),
      h('div', { class: 'side-row' }, themeSwitch(), themeButton('side-icon'),
        h('button', { class: 'side-icon kbd-btn', type: 'button', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', onclick: showShortcuts }, icon('keyboard')))));
}

/** Badges, balance and sync line: everything in the sidebar that changes while you watch. */
function paintSide() {
  const set = (id, n, cls = '') => { const b = document.querySelector(`.side [data-badge="${id}"]`); if (b) { b.textContent = n ? String(n) : ''; b.className = `badge ${cls}`; } };
  set('activity', S.pending, 'live');
  set('lists', S.lists?.lists.length);
  set('contacts', S.lists?.contacts.length);
  const bal = document.getElementById('wc-bal');
  if (bal) fill(bal, S.balance ? sens(`${fmtZec(S.balance.spendable)} ${unit()}`) : h('span', { class: 'skel' }));
  const sync = document.getElementById('wc-sync');
  if (sync) fill(sync, h('span', { class: `pulse ${S.syncing ? 'on' : ''}` }), S.syncing ? 'Syncing…' : S.balance ? `Synced · ${S.balance.chainHeight.toLocaleString()}` : 'Connecting…');
}

function renderShell() {
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Main' }, TABS.map((id) => navLink(id, 'data-tab')));
  fill(root, h('div', { class: 'app' }, sidebar(), main, tabbar));
  S.main = main; S.navEls = [...root.querySelectorAll('.side .nav'), tabbar];
  paintCollapse(); paintSide();
  narrow.onchange = paintCollapse;
  const first = location.hash.slice(1);
  go(VIEWS[first] && first !== 'more' ? first : 'home', true);
  window.onhashchange = () => { const v = location.hash.slice(1); if (VIEWS[v] && v !== S.view) go(v); };
  if (!S.keys) { S.keys = true; document.addEventListener('keydown', onKey); }
}

function band() {
  if (WEB) return h('div', { class: 'band sim', role: 'note' }, icon('info'), h('span', null, h('b', null, 'Web demo. '), 'Testnet play money on a simulated chain, kept only in this browser. To hold real ZEC, use the desktop app.'));
  if (S.status.simulated) return h('div', { class: 'band sim', role: 'note' }, icon('info'), h('span', null, h('b', null, 'Simulated chain. '), 'This is the demo engine: no network, no real ZEC. Build the Rust engine to use real funds.'));
  if (isTest()) return h('div', { class: 'band testnet', role: 'note' }, 'Testnet · play money, no real value');
  return null;
}

function topBar(id) {
  const v = VIEWS[id];
  const eye = iconBtn(S.revealed ? 'eyeOff' : 'eye', 'Show or hide balances (.)', () => setReveal(!S.revealed), { 'aria-pressed': String(S.revealed), id: 'eye' });
  const sync = iconBtn('refresh', 'Sync now', () => refresh(true), { id: 'syncbtn' });
  if (S.syncing) sync.firstChild.classList.add('spin');
  return h('header', { class: `top ${id === 'home' ? 'home' : ''}` },
    h('div', { class: 'titles' }, h('span', { class: 'wordmark' }, 'devoid'), h('h1', null, v.title), v.sub ? h('p', { class: 'sub' }, v.sub) : null),
    h('div', { class: 'top-actions' }, netBadge(), themeButton('icon-btn top-theme'), sync, eye));
}

export function go(view, first) {
  S.view = view;
  if (!first) history.replaceState(null, '', `#${view}`);
  for (const navEl of S.navEls) for (const a of navEl.querySelectorAll('a')) {
    const id = a.dataset.view ?? a.dataset.tab;
    const current = id === view || (navEl.classList.contains('tabbar') && id === 'more' && !TABS.includes(view));
    if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  S.onBalance = null;
  const body = h('div', { id: 'view' });
  fill(S.main, band(), topBar(view), body);
  VIEWS[view].render(body);
  if (!first) { S.main.focus({ preventScroll: true }); window.scrollTo(0, 0); }
}

function setReveal(on) {
  S.revealed = on;
  document.body.classList.toggle('reveal', on);
  const eye = document.getElementById('eye');
  if (eye) { eye.setAttribute('aria-pressed', String(on)); fill(eye, icon(on ? 'eyeOff' : 'eye')); }
  document.querySelectorAll('.redact').forEach((b) => b.setAttribute('aria-pressed', String(on)));
}

async function refresh(withSync) {
  S.syncing = true;
  document.querySelector('#syncbtn .ic')?.classList.add('spin');
  S.onBalance?.(); paintSide();
  if (withSync) await api('/api/sync');
  const [r, hist] = await Promise.all([api('/api/engine/balance'), api('/api/engine/history', { limit: 50 })]);
  S.syncing = false;
  document.querySelector('#syncbtn .ic')?.classList.remove('spin');
  if (r.ok) S.balance = r.result;
  if (hist.ok) S.pending = hist.result.transactions.filter((t) => t.status === 'pending').length;
  const btn = document.getElementById('syncbtn');
  if (btn && S.balance) btn.title = `Synced to block ${S.balance.chainHeight}. Sync now`;
  S.onBalance?.(); paintSide();
}

// ---- keyboard ---------------------------------------------------------------------------------
const SHORTCUTS = [
  ['N', 'New batch'], ['G then H', 'Home'], ['G then S', 'Send'], ['G then R', 'Receive'], ['G then A', 'Activity'],
  ['G then L', 'Lists'], ['G then C', 'Contacts'], ['G then ,', 'Settings'], ['T', 'Light or dark theme'], ['.', 'Show or hide balances'],
  ['[', 'Collapse or expand the sidebar'], ['?', 'This list'],
];
function showShortcuts() {
  modal('Keyboard shortcuts', () => h('dl', { class: 'shortcuts' }, SHORTCUTS.map(([k, what]) => [h('dt', null, k.split(' then ').map((x, i) => [i ? h('span', { class: 'faint small' }, ' then ') : null, h('kbd', null, x)])), h('dd', null, what)])));
}
let gAt = 0;
function onKey(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !S.main?.isConnected) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (gAt && Date.now() - gAt < 1200) {
    gAt = 0;
    const view = Object.keys(VIEWS).find((id) => VIEWS[id].key === k);
    if (view) { e.preventDefault(); go(view); }
    return;
  }
  const act = { g: () => { gAt = Date.now(); }, n: newBatch, t: toggleTheme, '.': () => setReveal(!S.revealed), '[': () => setCollapsed(storage('devoid-side') !== 'collapsed'), '?': showShortcuts }[e.key === '?' ? '?' : k];
  if (act) { e.preventDefault(); act(); }
}

function viewMore(el) {
  const item = (id) => h('a', { href: `#${id}`, onclick: (e) => { e.preventDefault(); go(id); } }, h('span', { class: 'tile-ico' }, icon(VIEWS[id].icon)), h('span', null, VIEWS[id].label), h('span', { class: 'chev' }, icon('chevronRight')));
  el.append(h('div', { class: 'stack-lg' },
    h('div', { class: 'card' }, h('div', { class: 'menu-list' }, ['lists', 'contacts', 'settings'].map(item))),
    h('div', { class: 'card row between' }, h('span', null, h('b', null, 'Theme'), h('div', { class: 'small muted' }, 'Light or dark')), themeSwitch()),
    h('p', { class: 'hint' }, WEB ? 'Web demo: simulated engine in this browser.' : S.status.simulated ? 'Engine: simulated demo.' : `Engine: devoid-engine, self-test ${S.status.engineVerified ? 'passed' : 'not run'}.`)));
}

nav.go = go;
nav.refresh = refresh;
nav.setReveal = setReveal;
nav.paintSide = paintSide;
boot();
