// Devoid UI: boot, shell, router, theme, balance refresh. Each screen lives in views/.
import { S, nav, api, h, iconBtn, errorNote, isTest, storage, loadLists, fill } from './lib.js';
import { icon, mark } from './icons.js';
import { renderWelcome, renderGate } from './views/welcome.js';
import { viewHome } from './views/home.js';
import { viewSend } from './views/send.js';
import { viewReceive } from './views/receive.js';
import { viewActivity } from './views/activity.js';
import { viewLists } from './views/lists.js';
import { viewContacts } from './views/contacts.js';
import { viewSettings, applyTheme } from './views/settings.js';

const root = document.getElementById('app');

const VIEWS = {
  home: { label: 'Home', icon: 'home', title: 'Overview', render: viewHome },
  send: { label: 'Send', icon: 'send', title: 'Send to many', sub: 'Paste or import a list. Devoid checks every address and shows what will be visible before anything is sent.', render: viewSend },
  receive: { label: 'Receive', icon: 'receive', title: 'Receive', sub: 'Share your shielded address, or a payment request with the amount filled in.', render: viewReceive },
  activity: { label: 'Activity', icon: 'activity', title: 'Activity', sub: 'Every payment in and out, with its status on chain.', render: viewActivity },
  lists: { label: 'Lists', icon: 'lists', title: 'Lists', sub: 'Reusable recipient lists for payroll, grants and DAO payouts. They stay on this computer.', render: viewLists },
  contacts: { label: 'Contacts', icon: 'contacts', title: 'Contacts', sub: 'People you pay often. Pick them straight into a batch.', render: viewContacts },
  settings: { label: 'Settings', icon: 'settings', title: 'Settings', render: viewSettings },
  more: { label: 'More', icon: 'more', title: 'More', render: viewMore, hidden: true },
};
const TABS = ['home', 'send', 'receive', 'activity', 'more'];

(function loadToken() {
  const m = /token=([\w-]+)/.exec(location.hash);
  try {
    if (m) { sessionStorage.setItem('devoid-token', m[1]); history.replaceState(null, '', location.pathname); }
    S.token = m ? m[1] : sessionStorage.getItem('devoid-token');
  } catch { S.token = m ? m[1] : null; }
})();
applyTheme(storage('devoid-theme'));

async function boot() {
  if (!S.token) {
    renderGate(root, 'Open Devoid from its link', h('p', { class: 'sub' }, 'The server prints a private link when it starts. Open that link in this browser; it carries the key that lets this page talk to your wallet.'));
    return;
  }
  const r = await api('/api/status');
  if (!r.ok) {
    renderGate(root, 'Cannot reach the wallet', h('div', { class: 'stack' }, errorNote(r.error), h('p', { class: 'sub' }, 'Restart the server and open the new link it prints.')));
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

function netBadge() {
  return isTest()
    ? h('span', { class: 'net test', title: 'Testnet: play money with no value' }, h('span', { class: 'dot test' }), h('span', null, 'Testnet'))
    : h('span', { class: 'net', title: 'Mainnet: real ZEC' }, h('span', { class: 'dot' }), h('span', null, 'Mainnet'));
}

function renderShell() {
  const link = (id, attr) => h('a', { href: `#${id}`, [attr]: id, onclick: (e) => { e.preventDefault(); go(id); } }, icon(VIEWS[id].icon), h('span', null, VIEWS[id].label));
  const side = h('aside', { class: 'side' },
    h('a', { class: 'brand', href: '#home', onclick: (e) => { e.preventDefault(); go('home'); } }, mark(), h('span', { class: 'wordmark' }, 'devoid')),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, Object.keys(VIEWS).filter((k) => !VIEWS[k].hidden).map((id) => link(id, 'data-view'))),
    h('div', { class: 'side-foot' }, netBadge(),
      h('div', { class: 'engine-line' }, h('span', { class: `dot ${S.status.simulated ? 'warn' : ''}` }), h('span', null, S.status.simulated ? 'Simulated engine' : S.status.engineVerified ? 'Engine verified' : 'Engine'))));
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Main' }, TABS.map((id) => link(id, 'data-tab')));
  const bands = [];
  if (S.status.simulated) bands.push(h('div', { class: 'band sim', role: 'note' }, icon('info'), h('span', null, h('b', null, 'Simulated chain. '), 'This is the demo engine: no network, no real ZEC. Build the Rust engine to use real funds.')));
  else if (isTest()) bands.push(h('div', { class: 'band testnet', role: 'note' }, 'Testnet · play money, no real value'));
  fill(root, h('div', { class: 'app' }, ...bands, side, main, tabbar));
  S.main = main; S.navEls = [side.querySelector('.nav'), tabbar];
  const first = location.hash.slice(1);
  go(VIEWS[first] ? first : 'home', true);
  window.onhashchange = () => { const v = location.hash.slice(1); if (VIEWS[v] && v !== S.view) go(v); };
}

function topBar(id) {
  const v = VIEWS[id];
  const eye = iconBtn(S.revealed ? 'eyeOff' : 'eye', 'Show or hide balances', () => setReveal(!S.revealed), { 'aria-pressed': String(S.revealed), id: 'eye' });
  const sync = iconBtn('refresh', 'Sync now', () => refresh(true), { id: 'syncbtn' });
  if (S.syncing) sync.firstChild.classList.add('spin');
  return h('header', { class: `top ${id === 'home' ? 'home' : ''}` },
    h('div', { class: 'titles' }, h('span', { class: 'wordmark' }, 'devoid'), h('h1', null, v.title), v.sub ? h('p', { class: 'sub' }, v.sub) : null),
    h('div', { class: 'top-actions' }, netBadge(), sync, eye));
}

export function go(view, first) {
  S.view = view;
  if (!first) history.replaceState(null, '', `#${view}`);
  for (const navEl of S.navEls) for (const a of navEl.children) {
    const id = a.dataset.view ?? a.dataset.tab;
    const current = id === view || (navEl.classList.contains('tabbar') && id === 'more' && !TABS.includes(view));
    if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  S.onBalance = null;
  const body = h('div', { id: 'view' });
  fill(S.main, topBar(view), body);
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
  S.onBalance?.();
  if (withSync) await api('/api/sync');
  const r = await api('/api/engine/balance');
  S.syncing = false;
  document.querySelector('#syncbtn .ic')?.classList.remove('spin');
  if (r.ok) S.balance = r.result;
  const btn = document.getElementById('syncbtn');
  if (btn && S.balance) btn.title = `Synced to block ${S.balance.chainHeight}. Sync now`;
  S.onBalance?.();
}

function viewMore(el) {
  const item = (id) => h('a', { href: `#${id}`, onclick: (e) => { e.preventDefault(); go(id); } }, h('span', { class: 'tile-ico' }, icon(VIEWS[id].icon)), h('span', null, VIEWS[id].label), h('span', { class: 'chev' }, icon('chevronRight')));
  el.append(h('div', { class: 'card' }, h('div', { class: 'menu-list' }, ['lists', 'contacts', 'settings'].map(item))),
    h('p', { class: 'hint' }, S.status.simulated ? 'Engine: simulated demo.' : `Engine: devoid-engine, self-test ${S.status.engineVerified ? 'passed' : 'not run'}.`));
}

nav.go = go;
nav.refresh = refresh;
nav.setReveal = setReveal;
boot();
