import { icon, mark } from './icons.js';
import { qrSvgPath } from './qr.js';

// ---- plumbing ------------------------------------------------------------------------------
const root = document.getElementById('app');
const S = { token: null, status: null, view: 'send', balance: null, revealed: false, draft: { text: '', fundingPools: '' }, timer: null };

(function loadToken() {
  const m = /token=([\w-]+)/.exec(location.hash);
  try {
    if (m) { sessionStorage.setItem('devoid-token', m[1]); history.replaceState(null, '', location.pathname); }
    S.token = m ? m[1] : sessionStorage.getItem('devoid-token');
  } catch { S.token = m ? m[1] : null; }
})();

async function api(path, body = {}) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${S.token}` }, body: JSON.stringify(body) });
    return await r.json();
  } catch {
    return { ok: false, error: { code: 'offline', message: 'Devoid could not reach its local server. Check that it is still running.' } };
  }
}

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const $btn = (label, cls, onclick, ic) => h('button', { class: `btn ${cls ?? ''}`, type: 'button', onclick }, ic ? icon(ic) : null, label);

function zec(z, min = 2) {
  const n = BigInt(z ?? 0); const neg = n < 0n; const a = neg ? -n : n;
  const whole = (a / 100000000n).toString(); let frac = (a % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  frac = frac.padEnd(min, '0');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
function toast(msg) { const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }
function when(sec) { return sec ? new Date(sec * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not yet mined'; }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy is blocked here. Select the text and copy it yourself.'); } }
const short = (a) => (a.length > 24 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a);
const poolName = { ironwood: 'Ironwood', orchard: 'Orchard', sapling: 'Sapling', transparent: 'Transparent' };

function errorNote(err) {
  if (!err) return null;
  const extra = [];
  if (err.details?.shortfallZat) extra.push(h('span', { class: 'small' }, `Short by ${zec(err.details.shortfallZat)} ZEC.`));
  return h('div', { class: 'note err', role: 'alert' }, h('b', null, err.message), ...extra);
}

// ---- boot ----------------------------------------------------------------------------------
async function boot() {
  if (!S.token) {
    root.replaceChildren(h('div', { class: 'gate' }, brand(true), h('h1', null, 'Open Devoid from its link'), h('p', { class: 'lede' }, 'The server prints a private link when it starts. Open that link in this browser; it carries the key that lets this page talk to your wallet.')));
    return;
  }
  const r = await api('/api/status');
  if (!r.ok) { root.replaceChildren(h('div', { class: 'gate' }, brand(true), h('h1', null, 'Cannot reach the wallet'), errorNote(r.error) ?? '', h('p', { class: 'muted' }, 'Restart the server and open the new link it prints.'))); return; }
  S.status = r.result;
  if (!S.status.wallet.exists) return renderGate();
  renderShell();
  refresh(true);
  clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden) refresh(false); }, 20000);
}

function brand(dark) {
  return h('div', { class: 'brand' }, mark(), h('b', null, 'Devoid'));
}

// ---- gate: create / restore ----------------------------------------------------------------
function renderGate() {
  let mode = 'create';
  const box = h('div', { class: 'gate' });
  const draw = (phrase) => {
    box.replaceChildren(brand(true));
    if (phrase) return drawPhrase(box, phrase);
    const err = h('div');
    const pass = h('input', { type: 'password', autocomplete: 'new-password', id: 'p1' });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password', id: 'p2' });
    const words = h('textarea', { id: 'ph', rows: 3, placeholder: 'word1 word2 word3 …', spellcheck: 'false', autocomplete: 'off' });
    const net = h('select', { id: 'net' }, h('option', { value: 'main' }, 'Mainnet (real ZEC)'), h('option', { value: 'test' }, 'Testnet (play money)'));
    const go = $btn(mode === 'create' ? 'Create wallet' : 'Restore wallet', '', async () => {
      err.replaceChildren();
      if (pass.value.length < 8) return err.append(errorNote({ message: 'Use a passphrase of at least 8 characters.' }));
      if (pass.value !== pass2.value) return err.append(errorNote({ message: 'The two passphrases are different.' }));
      go.disabled = true;
      const r = await api('/api/engine/create', { passphrase: pass.value, network: net.value, phrase: mode === 'restore' ? words.value : undefined });
      go.disabled = false;
      if (!r.ok) return err.append(errorNote(r.error));
      pass.value = pass2.value = '';
      if (r.result.phrase) draw(r.result.phrase); else done();
    });
    box.append(
      h('h1', null, mode === 'create' ? 'A wallet that pays everyone at once' : 'Restore a wallet'),
      h('p', { class: 'lede' }, mode === 'create' ? 'Devoid sends Zcash to many people in one go, privately. Your keys never leave this computer.' : 'Enter your recovery phrase. Devoid then scans the chain for your funds.'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Wallet setup' },
        h('button', { type: 'button', 'aria-pressed': String(mode === 'create'), onclick: () => { mode = 'create'; draw(); } }, 'New wallet'),
        h('button', { type: 'button', 'aria-pressed': String(mode === 'restore'), onclick: () => { mode = 'restore'; draw(); } }, 'Restore')),
      h('div', { class: 'stack', style: null }, h('div'),
        mode === 'restore' ? h('div', null, h('label', { class: 'f', for: 'ph' }, 'Recovery phrase'), words) : null,
        h('div', null, h('label', { class: 'f', for: 'net' }, 'Network'), net),
        h('div', null, h('label', { class: 'f', for: 'p1' }, 'Passphrase'), pass, h('div', { class: 'small muted' }, 'Encrypts the keys on this computer. If you forget it, only the recovery phrase can bring your funds back.')),
        h('div', null, h('label', { class: 'f', for: 'p2' }, 'Repeat passphrase'), pass2),
        err, go));
  };
  const done = () => boot();
  const drawPhrase = (b, phrase) => {
    const ok = h('input', { type: 'checkbox', id: 'wrote' });
    const go = $btn('Open wallet', '', done); go.disabled = true;
    ok.addEventListener('change', () => { go.disabled = !ok.checked; });
    b.append(h('h1', null, 'Write down your recovery phrase'),
      h('p', { class: 'lede' }, 'These 24 words are your wallet. Anyone with them can take your funds, and nobody can recover them for you. Write them on paper, in order.'),
      h('div', { class: 'phrase' }, phrase.split(' ').map((w) => h('span', null, w))),
      h('label', { class: 'check', for: 'wrote' }, ok, 'I wrote the phrase down and stored it somewhere safe.'), go);
  };
  draw();
  root.replaceChildren(box);
}

// ---- shell ---------------------------------------------------------------------------------
const NAV = [['send', 'Send', 'send'], ['receive', 'Receive', 'receive'], ['activity', 'Activity', 'activity'], ['lists', 'Lists', 'lists'], ['settings', 'Settings', 'settings']];

function renderShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map(([id, label, ic]) => h('a', { href: `#${id}`, 'data-view': id, onclick: (e) => { e.preventDefault(); go(id); } }, icon(ic), h('span', null, label))));
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const kids = [];
  if (S.status.simulated) kids.push(h('div', { class: 'sim', role: 'note' }, h('b', null, 'Simulated chain. '), 'This is the demo engine: no network, no real ZEC. Build the Rust engine to use real funds.'));
  kids.push(h('aside', { class: 'rail' }, brand(), nav, h('div', { class: 'foot' }, S.status.wallet.network === 'main' ? 'Mainnet' : 'Testnet', S.status.simulated ? ' · simulated' : '')), main);
  root.replaceChildren(h('div', { class: 'shell' }, ...kids));
  S.main = main; S.nav = nav;
  S.view = (location.hash.slice(1) || S.view);
  if (!NAV.some(([id]) => id === S.view)) S.view = 'send';
  go(S.view, true);
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (NAV.some(([id]) => id === v) && v !== S.view) go(v); });
}

function go(view, first) {
  S.view = view;
  if (!first) history.replaceState(null, '', `#${view}`);
  for (const a of S.nav.children) { if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  S.main.replaceChildren(balanceBlock(), h('div', { id: 'view' }));
  ({ send: viewSend, receive: viewReceive, activity: viewActivity, lists: viewLists, settings: viewSettings })[view](document.getElementById('view'));
}

function balanceBlock() {
  const b = S.balance;
  const fig = h('span', { class: 'figure' }, b ? zec(b.spendable) : '—');
  const btn = h('button', { class: 'redact', type: 'button', 'aria-pressed': String(S.revealed), 'aria-label': 'Spendable balance. Press to show or hide.', onclick: () => { S.revealed = !S.revealed; btn.setAttribute('aria-pressed', String(S.revealed)); } },
    fig, h('span', { class: 'unit' }, 'ZEC'), h('span', { class: 'bar' }));
  const meta = h('div', { class: 'balance-meta', id: 'bmeta' });
  fillMeta(meta);
  return h('div', { class: 'balance', id: 'balance' }, btn, meta);
}
function fillMeta(meta) {
  const b = S.balance; if (!meta) return;
  const parts = [];
  if (b) {
    if (BigInt(b.pendingReceived) + BigInt(b.pendingChange) > 0n) parts.push(h('span', null, `${zec(BigInt(b.pendingReceived) + BigInt(b.pendingChange))} ZEC arriving`));
    parts.push(h('span', null, S.syncing ? 'Syncing…' : b.scanFraction < 1 ? `Scanning ${(b.scanFraction * 100).toFixed(1)}%` : `Synced to block ${b.chainHeight}`));
    const pools = Object.entries(b.pools).filter(([, p]) => BigInt(p.total) > 0n).map(([k, p]) => `${poolName[k]} ${zec(p.spendable)}`);
    if (pools.length) parts.push(h('span', null, pools.join(' · ')));
  } else parts.push(h('span', null, 'Loading…'));
  meta.replaceChildren(...parts);
}

async function refresh(withSync) {
  S.syncing = true; fillMeta(document.getElementById('bmeta'));
  if (withSync) await api('/api/sync');
  const r = await api('/api/engine/balance');
  S.syncing = false;
  if (r.ok) {
    S.balance = r.result;
    const f = document.querySelector('#balance .figure'); if (f) f.textContent = zec(r.result.spendable);
  }
  fillMeta(document.getElementById('bmeta'));
}

// ---- send ----------------------------------------------------------------------------------
function viewSend(el) {
  let step = 'compose'; let checked = null; let plan = null;
  const draw = () => {
    el.replaceChildren(
      h('h1', null, 'Send to many'),
      h('p', { class: 'lede' }, 'Paste or import a list. Devoid checks every address, then shows what will be visible before anything is sent.'),
      h('ol', { class: 'steps' }, ['Recipients', 'Review', 'Send'].map((t, i) => h('li', { 'aria-current': (['compose', 'review', 'sending'][i] === step || (step === 'done' && i === 2)) ? 'step' : null, class: (['compose', 'review', 'sending'].indexOf(step) > i || step === 'done' && i < 2) ? 'done' : '' }, t))),
      step === 'compose' ? compose() : step === 'review' ? review() : sending());
  };

  function compose() {
    const ta = h('textarea', { id: 'batch', spellcheck: 'false', autocomplete: 'off', placeholder: 'address,amount,memo\nu1…,0.25,March invoice\nzs1…,1.5,\n\nAmounts are in ZEC. Columns can be named address, amount, memo, label.' }, S.draft.text);
    ta.value = S.draft.text;
    ta.addEventListener('input', () => { S.draft.text = ta.value; checked = null; table.replaceChildren(); next.disabled = true; });
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain', class: 'sr', id: 'file', onchange: async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 2_000_000) return toast('That file is over 2 MB.'); ta.value = S.draft.text = await f.text(); check(); } });
    const msg = h('div'); const table = h('div'); const savebox = h('div');
    const next = $btn('Review payment', '', () => toReview()); next.disabled = true;
    const pools = h('select', { id: 'pools', onchange: (e) => { S.draft.fundingPools = e.target.value; checked = null; } },
      h('option', { value: '' }, 'Automatic (least visible)'), h('option', { value: 'ironwood' }, 'Ironwood only'), h('option', { value: 'sapling' }, 'Sapling only'));
    pools.value = S.draft.fundingPools;
    const check = async () => {
      msg.replaceChildren(); table.replaceChildren();
      const r = await api('/api/batch/validate', { text: ta.value });
      if (!r.ok) return msg.append(errorNote(r.error));
      if (!r.result.ok) return msg.append(errorNote({ message: r.result.message }));
      checked = r.result; drawTable(); };
    const drawTable = () => {
      const c = checked; const bad = c.rows.filter((r) => r.errors.length);
      table.replaceChildren(
        h('div', { class: 'row between' },
          h('div', null, h('b', null, `${c.valid} ready`), bad.length ? h('span', { class: 'muted' }, `, ${bad.length} need attention`) : '', h('span', { class: 'muted' }, ` · total ${c.totalZec} ZEC`)),
          bad.length ? $btn('Remove rows with problems', 'quiet small', () => { removeBad(); }) : null),
        h('div', { class: 'tablewrap' }, h('table', { class: 'ledger' },
          h('thead', null, h('tr', null, h('th', { class: 'gutter' }, 'Line'), h('th', null, 'Recipient'), h('th', null, 'Memo'), h('th', { class: 'amt' }, 'ZEC'))),
          h('tbody', null, c.rows.map((r) => h('tr', { class: r.errors.length ? 'bad' : r.warning ? 'dup' : '' },
            h('td', { class: 'gutter' }, r.line),
            h('td', null, h('div', { class: 'addr' }, r.address), r.label ? h('div', { class: 'small muted' }, r.label) : null, r.kind === 'transparent' ? h('span', { class: 'tag public' }, 'Transparent: public') : null, ...r.errors.map((e) => h('div', { class: 'why' }, e)), r.warning ? h('div', { class: 'small' }, r.warning) : null),
            h('td', { class: 'small' }, r.memo),
            h('td', { class: 'amt' }, r.amountZec ?? '')))))));
      next.disabled = bad.length > 0 || c.valid === 0;
    };
    const removeBad = () => {
      const keep = new Set(checked.rows.filter((r) => !r.errors.length).map((r) => r.line));
      const lines = ta.value.split(/\r?\n/);
      const hasHeader = /^\s*"?address/i.test(lines[0] ?? '');
      // Only safe for one-record-per-line input; otherwise ask for a manual fix.
      if (lines.filter((l) => l.trim()).length !== checked.rows.length + (hasHeader ? 1 : 0)) return toast('Some rows span several lines. Fix them in the text box instead.');
      ta.value = S.draft.text = lines.filter((l, i) => (hasHeader && i === 0) || keep.has(i + 1) || !l.trim()).join('\n'); check();
    };
    const toReview = async () => {
      next.disabled = true; msg.replaceChildren();
      const recipients = checked.rows.map((r) => ({ address: r.address, amountZat: r.amountZat, memo: r.memo || undefined }));
      const fundingPools = S.draft.fundingPools ? [S.draft.fundingPools] : undefined;
      const r = await api('/api/batch/plan', { recipients, fundingPools });
      next.disabled = false;
      if (!r.ok) return msg.append(errorNote(r.error));
      plan = { ...r.result, recipients, fundingPools }; step = 'review'; draw();
    };
    const saveLists = async () => {
      const name = h('input', { type: 'text', 'aria-label': 'List name', placeholder: 'Name this list' });
      savebox.replaceChildren(h('div', { class: 'row' }, name, $btn('Save list', 'small', async () => {
        if (!name.value.trim()) return;
        const cur = (await api('/api/lists')).result;
        cur.lists.push({ id: crypto.randomUUID(), name: name.value.trim().slice(0, 80), text: ta.value, updated: Date.now() });
        await api('/api/lists', { lists: cur.lists }); savebox.replaceChildren(); toast('List saved');
      }), $btn('Cancel', 'quiet small', () => savebox.replaceChildren())));
      name.focus();
    };
    queueMicrotask(() => { if (S.draft.text.trim()) check(); });
    return h('div', null,
      h('div', { class: 'panel' },
        h('label', { class: 'f', for: 'batch' }, 'Recipients'), ta,
        h('div', { class: 'row', 'aria-label': 'Actions' }, h('label', { class: 'btn quiet small', for: 'file' }, icon('upload'), 'Import file'), file,
          $btn('Check recipients', 'small', check, 'check'), $btn('Save as list', 'quiet small', saveLists), h('span', { class: 'small muted' }, 'Up to 2,000 recipients. 25 per transaction.')),
        savebox, msg),
      h('div', { class: 'panel' }, table, h('div', { class: 'row', 'aria-label': 'Options' }, h('div', null, h('label', { class: 'f', for: 'pools' }, 'Spend from'), pools), next)));
  }

  function review() {
    const f = plan.first; const need = plan.needsAck;
    const acks = new Set(); const err = h('div');
    const pass = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password' });
    const sendBtn = $btn(`Send ${plan.recipients.length} payment${plan.recipients.length === 1 ? '' : 's'}`, '', async () => {
      err.replaceChildren();
      if (!pass.value) return err.append(errorNote({ message: 'Enter your passphrase to sign.' }));
      sendBtn.disabled = true;
      const r = await api('/api/batch/send', { recipients: plan.recipients, fundingPools: plan.fundingPools, passphrase: pass.value, acknowledge: [...acks] });
      pass.value = '';
      if (!r.ok) { sendBtn.disabled = false; return err.append(errorNote(r.error)); }
      step = 'sending'; S.jobId = r.result.jobId; draw();
    }, 'lock');
    const sync = () => { sendBtn.disabled = need.some((n) => !acks.has(n)); };
    const labels = { transparent_recipient: 'I understand the transparent payments and their amounts will be public.', pool_crossing: 'I understand that the amount moving between pools will be public.' };
    const findings = f.privacy.findings.filter((x) => x.code !== 'shape_visible' || true);
    const levelNote = f.privacy.level === 'private' ? h('div', { class: 'note ok' }, h('b', null, 'Fully shielded'), 'Recipients, amounts and memos stay hidden. The chain shows only that a transaction happened, and roughly how big it is.')
      : h('div', { class: 'note warn' }, h('b', null, f.privacy.level === 'public' ? 'Some of this will be public' : 'Part of this will be visible'), 'Review what is exposed below.');
    queueMicrotask(sync);
    return h('div', { class: 'grid2' },
      h('div', null,
        h('div', { class: 'panel receipt' }, h('h2', null, 'Payment'),
          h('dl', null,
            h('dt', null, 'Recipients'), h('dd', null, plan.recipients.length),
            h('dt', null, 'Transactions'), h('dd', null, plan.transactions),
            h('dt', null, 'Sent to recipients'), h('dd', null, `${zec(plan.recipients.reduce((a, r) => a + BigInt(r.amountZat), 0n))} ZEC`),
            h('dt', null, plan.feeIsEstimate ? 'Network fees (estimate)' : 'Network fee'), h('dd', null, `${zec(plan.estimatedFeeZat, 4)} ZEC`),
            h('dt', null, 'Spending from'), h('dd', null, f.fundingPools.map((p) => poolName[p]).join(' + ')),
            h('div', { class: 'total' }, h('span', null, 'Total'), h('span', null, `${zec(plan.recipients.reduce((a, r) => a + BigInt(r.amountZat), 0n) + BigInt(plan.estimatedFeeZat))} ZEC`))),
          plan.sequential ? h('div', { class: 'note' }, h('b', null, `Sent as ${plan.transactions} transactions`), 'Each transaction pays up to 25 people. Later ones spend change from earlier ones, so Devoid waits for confirmations between them. Keep this window open.') : null)),
      h('div', null,
        h('div', { class: 'panel' }, h('h2', null, 'What others can see'), levelNote,
          ...findings.map((x) => h('div', { class: `note ${x.severity === 'info' ? '' : 'warn'}` }, x.message)),
          ...need.map((n) => { const cb = h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) acks.add(n); else acks.delete(n); sync(); } }); return h('label', { class: 'check' }, cb, labels[n] ?? n); })),
        h('div', { class: 'panel' }, h('label', { class: 'f', for: 'pw' }, 'Passphrase'), pass, h('div', { class: 'row', style: null }, sendBtn, $btn('Back', 'quiet', () => { step = 'compose'; draw(); })), err)));
  }

  function sending() {
    const msg = h('div', { class: 'muted' }, 'Starting…'); const bar = h('i'); const out = h('div'); const prog = h('div', { class: 'progress', role: 'progressbar' }, bar);
    let stop = false;
    (async () => {
      while (!stop) {
        const r = await api('/api/batch/job', { jobId: S.jobId });
        if (!r.ok) { out.replaceChildren(errorNote(r.error)); return; }
        const j = r.result;
        bar.style.width = `${Math.round((j.done / j.total) * 100)}%`; msg.textContent = j.message;
        if (j.state === 'done') {
          out.replaceChildren(h('div', { class: 'note ok' }, h('b', null, 'Sent'), `${j.txids.length} transaction${j.txids.length === 1 ? '' : 's'} broadcast. They show as pending until mined.`),
            h('div', { class: 'small mono' }, j.txids.map((t) => h('div', null, t))), h('div', { class: 'row' }, $btn('See activity', '', () => go('activity')), $btn('New batch', 'quiet', () => { S.draft.text = ''; step = 'compose'; draw(); })));
          S.draft.text = ''; refresh(false); step = 'done'; return;
        }
        if (j.state === 'failed') {
          out.replaceChildren(errorNote(j.error), h('div', { class: 'note' }, j.message), h('div', { class: 'row' }, $btn('Check activity', '', () => go('activity')), $btn('Back to recipients', 'quiet', () => { step = 'compose'; draw(); })));
          return;
        }
        await new Promise((r2) => setTimeout(r2, 1500));
        if (S.view !== 'send') return;
      }
    })();
    return h('div', { class: 'panel' }, h('h2', null, 'Sending'), prog, msg, out);
  }
  draw();
}

// ---- receive -------------------------------------------------------------------------------
async function viewReceive(el) {
  el.replaceChildren(h('h1', null, 'Receive'), h('p', { class: 'lede' }, 'Give people the shielded address. It hides who pays you and how much.'));
  const r = await api('/api/engine/addresses');
  if (!r.ok) return el.append(errorNote(r.error));
  const a = r.result;
  const block = (title, addr, note, tone, qr) => {
    let q = null;
    if (qr) { const { size, d } = qrSvgPath(addr); const ns = 'http://www.w3.org/2000/svg'; q = document.createElementNS(ns, 'svg'); q.setAttribute('viewBox', `0 0 ${size} ${size}`); q.setAttribute('class', 'qr'); q.setAttribute('role', 'img'); q.setAttribute('aria-label', `QR code for the ${title}`); const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); q.append(p); }
    return h('div', { class: 'addr-block' }, q ?? h('div'), h('div', null, h('h2', null, title, ' ', h('span', { class: `tag ${tone}` }, tone === 'public' ? 'Public' : 'Private')), h('div', { class: 'small muted' }, note), h('div', { class: 'addr-text' }, addr), $btn('Copy address', 'quiet small', () => copy(addr), 'copy')));
  };
  const extra = h('div');
  el.append(block('Shielded address', a.shielded, 'A unified address. Pays into the newest shielded pool automatically.', 'shielded', true),
    extra,
    $btn('New shielded address', 'quiet', async () => { const n = await api('/api/engine/newAddress'); if (n.ok) { extra.append(block('New shielded address', n.result.shielded, 'Same wallet, different address. Use one per contact to keep payments unlinkable by address.', 'shielded', true)); } else toast(n.error.message); }, 'plus'),
    h('h2', { class: 'section' }, ''),
    block('Sapling address', a.sapling, 'For senders whose wallet cannot use a unified address yet.', 'shielded', true),
    block('Transparent address', a.transparent, 'Everything sent here is visible on the blockchain. Shield it afterwards in Settings.', 'public', false));
}

// ---- activity ------------------------------------------------------------------------------
async function viewActivity(el) {
  el.replaceChildren(h('h1', null, 'Activity'), h('p', { class: 'lede' }, 'Payments in and out, with confirmations.'));
  const list = h('div'); const more = h('div'); el.append(list, more);
  let offset = 0;
  const load = async () => {
    const r = await api('/api/engine/history', { limit: 25, offset, outputs: true });
    if (!r.ok) return list.append(errorNote(r.error));
    const { transactions, hasMore } = r.result;
    if (!offset && !transactions.length) return list.append(h('div', { class: 'empty' }, 'No activity yet. Receive some ZEC, or send your first batch.'));
    transactions.forEach((t) => list.append(txRow(t)));
    offset += transactions.length; more.replaceChildren(hasMore ? $btn('Load more', 'quiet', load) : '');
  };
  await load();
}
function txRow(t) {
  const label = { sent: 'Sent', received: 'Received', shielded: 'Shielded', internal: 'Moved' }[t.kind] ?? t.kind;
  const ic = { sent: 'sent', received: 'received', shielded: 'shielded', internal: 'internal' }[t.kind] ?? 'check';
  const d = BigInt(t.balanceDeltaZat);
  const detail = h('div', { class: 'detail', hidden: true });
  const btn = h('button', { type: 'button', 'aria-expanded': 'false', onclick: () => { const o = detail.hidden; detail.hidden = !o; btn.setAttribute('aria-expanded', String(o)); } },
    h('span', { class: 'ico' }, icon(ic)),
    h('span', null, h('b', null, label), ' ', h('span', { class: `pill ${t.status}` }, t.status === 'pending' ? 'Pending' : `${t.confirmations} confirmation${t.confirmations === 1 ? '' : 's'}`),
      h('div', { class: 'small muted' }, t.sentOutputs ? `${t.sentOutputs} recipient${t.sentOutputs === 1 ? '' : 's'} · ` : '', when(t.blockTime))),
    h('span', { class: `amt ${d > 0n ? 'in' : ''}` }, `${d > 0n ? '+' : ''}${zec(d)}`));
  detail.append(
    h('div', { class: 'small mono muted' }, t.txid),
    t.feeZat != null ? h('div', { class: 'small' }, `Fee ${zec(t.feeZat, 4)} ZEC`) : null,
    t.poolCrossingZat ? h('div', { class: 'note warn small' }, `${zec(t.poolCrossingZat)} ZEC crossed between pools and is visible on the chain.`) : null,
    ...(t.outputs ?? []).filter((o) => !o.isChange).map((o) => h('div', { class: 'row small', style: null }, h('span', { class: 'mono' }, o.address ? short(o.address) : 'To you'), h('b', null, `${zec(o.valueZat)} ZEC`), h('span', { class: `tag ${o.pool === 'transparent' ? 'public' : 'shielded'}` }, poolName[o.pool] ?? o.pool), o.memo ? h('span', { class: 'muted' }, `“${o.memo}”`) : null)));
  return h('div', { class: 'tx' }, btn, detail);
}

// ---- lists ---------------------------------------------------------------------------------
async function viewLists(el) {
  el.replaceChildren(h('h1', null, 'Lists'), h('p', { class: 'lede' }, 'Saved recipient lists, such as payroll or a monthly airdrop. They stay on this computer.'));
  const r = await api('/api/lists'); if (!r.ok) return el.append(errorNote(r.error));
  const lists = r.result.lists;
  if (!lists.length) return el.append(h('div', { class: 'empty' }, 'No saved lists. On the Send page, choose “Save as list” after you paste recipients.'));
  for (const l of lists) {
    const n = l.text.split(/\r?\n/).filter((x) => x.trim()).length;
    el.append(h('div', { class: 'panel' }, h('div', { class: 'row between' }, h('div', null, h('h3', null, l.name), h('div', { class: 'small muted' }, `${n} line${n === 1 ? '' : 's'} · saved ${new Date(l.updated).toLocaleDateString()}`)),
      h('div', { class: 'row' }, $btn('Use list', 'small', () => { S.draft.text = l.text; go('send'); }), $btn('Delete', 'quiet small', async () => { await api('/api/lists', { lists: lists.filter((x) => x.id !== l.id) }); viewLists(el); }, 'trash')))));
  }
}

// ---- settings ------------------------------------------------------------------------------
async function viewSettings(el) {
  el.replaceChildren(h('h1', null, 'Settings'));
  const st = (await api('/api/settings')).result;
  // connection
  let mode = st.mode; const servers = h('input', { type: 'text', id: 'srv', value: st.servers, spellcheck: 'false' }); const socks = h('input', { type: 'text', id: 'sx', value: st.socksProxy, placeholder: '127.0.0.1:9050' });
  const segs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Connection' });
  const drawSeg = () => { segs.replaceChildren(...[['direct', 'Direct'], ['tor', 'Tor'], ['socks5', 'SOCKS5 proxy']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(mode === v), onclick: () => { mode = v; drawSeg(); socksRow.hidden = mode !== 'socks5'; } }, l))); };
  const socksRow = h('div', { hidden: mode !== 'socks5' }, h('label', { class: 'f', for: 'sx' }, 'Proxy address'), socks);
  drawSeg();
  const connMsg = h('div');
  el.append(h('div', { class: 'panel' }, h('h2', null, 'Network connection'), h('p', { class: 'muted' }, 'Devoid asks a lightwalletd server for blocks. Tor hides your IP address from that server.'), segs,
    h('div', { class: 'stack' }, h('div', null, h('label', { class: 'f', for: 'srv' }, 'Servers'), servers, h('div', { class: 'small muted' }, 'A preset (zecrocks, ywallet) or host:port, comma separated.')), socksRow, connMsg,
      $btn('Save connection', 'small', async () => { const r = await api('/api/settings', { mode, servers: servers.value.trim() || 'zecrocks', socksProxy: socks.value.trim() }); connMsg.replaceChildren(r.ok ? h('div', { class: 'note ok' }, 'Saved.') : errorNote(r.error)); }))));
  // phrase
  const pw = h('input', { type: 'password', id: 'rp', autocomplete: 'current-password' }); const out = h('div');
  el.append(h('div', { class: 'panel' }, h('h2', null, 'Recovery phrase'), h('p', { class: 'muted' }, 'Show the words that restore this wallet. Make sure nobody can see your screen.'),
    h('label', { class: 'f', for: 'rp' }, 'Passphrase'), pw, h('div', { class: 'row' }, $btn('Show recovery phrase', 'quiet small', async () => {
      const r = await api('/api/engine/revealPhrase', { passphrase: pw.value }); pw.value = '';
      if (!r.ok) return out.replaceChildren(errorNote(r.error));
      out.replaceChildren(h('div', { class: 'phrase' }, r.result.phrase.split(' ').map((w) => h('span', null, w))), $btn('Hide', 'quiet small', () => out.replaceChildren()));
    })), out));
  // change passphrase
  const o1 = h('input', { type: 'password', id: 'o1', autocomplete: 'current-password' }); const n1 = h('input', { type: 'password', id: 'n1', autocomplete: 'new-password' }); const cm = h('div');
  el.append(h('div', { class: 'panel' }, h('h2', null, 'Passphrase'), h('div', { class: 'stack' }, h('div', null, h('label', { class: 'f', for: 'o1' }, 'Current passphrase'), o1), h('div', null, h('label', { class: 'f', for: 'n1' }, 'New passphrase'), n1), cm,
    $btn('Change passphrase', 'quiet small', async () => { const r = await api('/api/engine/changePassphrase', { passphrase: o1.value, newPassphrase: n1.value }); o1.value = n1.value = ''; cm.replaceChildren(r.ok ? h('div', { class: 'note ok' }, 'Passphrase changed.') : errorNote(r.error)); }))));
  // shield
  const shieldOut = h('div');
  el.append(h('div', { class: 'panel' }, h('h2', null, 'Shield transparent funds'), h('p', { class: 'muted' }, 'Move ZEC from your transparent address into the shielded pool so it can be spent privately. The transfer itself is visible.'), shieldOut,
    $btn('Preview shielding', 'quiet small', async () => {
      const r = await api('/api/engine/shield', { dryRun: true });
      if (!r.ok) return shieldOut.replaceChildren(h('div', { class: r.error.code === 'nothing_to_shield' ? 'note' : 'note err' }, r.error.code === 'nothing_to_shield' ? 'There is no transparent balance ready to shield.' : r.error.message));
      const s = r.result; const p = h('input', { type: 'password', 'aria-label': 'Passphrase' }); const m = h('div');
      shieldOut.replaceChildren(h('div', { class: 'note warn' }, h('b', null, `Shield ${zec(BigInt(s.inputs.transparent.valueZat))} ZEC`), `Fee ${zec(s.feeZat, 4)} ZEC. ${s.privacy.findings[0]?.message ?? ''}`),
        h('div', { class: 'row' }, p, $btn('Shield now', 'small', async () => { const x = await api('/api/engine/shield', { passphrase: p.value, fingerprint: s.fingerprint, acknowledge: s.privacy.requiresAck }); p.value = ''; if (!x.ok) return m.replaceChildren(errorNote(x.error)); shieldOut.replaceChildren(h('div', { class: 'note ok' }, 'Shielding sent. It shows in Activity as pending.')); refresh(false); })), m);
    })));
  // about
  el.append(h('div', { class: 'panel flat small muted' }, S.status.simulated ? 'Engine: simulated demo. Nothing here touches a real network.' : `Engine: devoid-engine (librustzcash), self-test ${S.status.engineVerified ? 'passed' : 'not run'}.`, ` Wallet network: ${S.status.wallet.network}.`));
}

boot();
