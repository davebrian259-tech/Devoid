// Send: compose a batch (paste, import, contacts, lists), check it live, review what the chain will
// see, sign, then follow the transactions out. The flow survives navigating away and back.
import { S, nav, api, h, btn, copy, download, note, errorNote, modal, unit, isTest, poolName, saveLists, loadLists, toast, emptyState, short, fill } from '../lib.js';
import { icon } from '../icons.js';
import { fmtZec, estimateFeeZat, chunkSizes, parseZecToZat, splitEvenly, rowsToBatchText, zip321Amount, toCsv, monogram, hueOf, TX_CHUNK } from '../calc.js';

const rowOut = (r, amount) => ({ address: r.address, amount: amount ?? (r.amountZat != null ? zip321Amount(r.amountZat) : ''), memo: r.memo ?? '', label: r.label ?? '' });

/** Adds recipients to the draft, keeping what is there and normalising it to one format. */
export async function appendRecipients(newRows) {
  if (!S.draft.text.trim()) { S.draft.text = rowsToBatchText(newRows); return; }
  const r = await api('/api/batch/validate', { text: S.draft.text });
  if (r.ok && r.result.ok) S.draft.text = rowsToBatchText([...r.result.rows.map((x) => rowOut(x)), ...newRows]);
  else S.draft.text = `${S.draft.text.trimEnd()}\n${rowsToBatchText(newRows).split('\n').slice(1).join('\n')}`;
}

const kindPill = (kind) => (kind === 'transparent'
  ? h('span', { class: 'pill public' }, icon('eye'), 'Public')
  : kind ? h('span', { class: 'pill ok' }, icon('shielded'), kind === 'sapling' ? 'Sapling' : 'Shielded') : null);

// Sends are funded from shielded pools only (the engine never spends transparent funds on a
// payment), so "spendable" here must leave transparent money out or the totals would promise
// funds the engine will refuse to use.
const SHIELDED = ['ironwood', 'orchard', 'sapling'];
const poolZat = (k, field) => BigInt(S.balance?.pools?.[k]?.[field] ?? 0);
function spendableFor(pools) {
  if (!S.balance) return null;
  return (pools ? [pools] : SHIELDED).reduce((a, k) => a + poolZat(k, 'spendable'), 0n);
}
function waitingFor(pools) {
  return (pools ? [pools] : SHIELDED).reduce((a, k) => a + poolZat(k, 'pendingChange') + poolZat(k, 'pendingReceived'), 0n);
}

export function viewSend(el) {
  // A batch in flight or one that stopped stays on screen until dealt with; a finished one does not.
  if (S.sendFlow?.step === 'done') S.sendFlow = { step: 'compose' };
  const F = (S.sendFlow ??= { step: 'compose' });
  let checked = null;

  const draw = () => {
    const at = F.step === 'compose' ? 0 : F.step === 'review' ? 1 : 2;
    fill(el, 
      h('ol', { class: 'steps', 'aria-label': 'Progress' }, ['Recipients', 'Review', 'Send'].map((t, i) => h('li', { 'aria-current': i === at ? 'step' : null, class: i < at || (F.step === 'done' && i === 2) ? 'done' : '' }, t))),
      F.step === 'compose' ? compose() : F.step === 'review' ? review() : result());
  };
  const restart = () => { el.replaceChildren(); viewSend(el); };

  // ---- compose -------------------------------------------------------------------------------
  function compose() {
    const ta = h('textarea', { id: 'batch', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Recipients', placeholder: 'address,amount,memo\nu1…,0.25,March invoice\nzs1…,1.5,\n\nOne recipient per line. Amounts in ZEC. Columns can be named address, amount, memo and label.' });
    ta.value = S.draft.text;
    const msg = h('div'); const ledger = h('div'); const tray = h('div', { class: 'tools-tray', hidden: true }); const summary = h('div', { class: 'stack' });
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain', class: 'sr', id: 'file', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 2_000_000) return toast('That file is over 2 MB.', 'alert');
      ta.value = S.draft.text = await f.text(); check(); } });
    const pools = h('select', { id: 'pools', 'aria-label': 'Spend from', onchange: (e) => { S.draft.fundingPools = e.target.value; drawSummary(); } },
      h('option', { value: '' }, 'Automatic (least visible)'), h('option', { value: 'ironwood' }, 'Ironwood only'), h('option', { value: 'sapling' }, 'Sapling only'));
    pools.value = S.draft.fundingPools;
    const next = btn('Review payment', 'lg block trail', () => toReview(), 'arrowRight', { id: 'review' }); next.disabled = true;

    let timer = null;
    ta.addEventListener('input', () => {
      S.draft.text = ta.value; checked = null; next.disabled = true;
      clearTimeout(timer); timer = setTimeout(check, 650);
    });

    async function check() {
      clearTimeout(timer);
      msg.replaceChildren();
      if (!ta.value.trim()) { checked = null; ledger.replaceChildren(); tray.hidden = true; drawSummary(); return; }
      const r = await api('/api/batch/validate', { text: ta.value });
      if (!r.ok) return msg.append(errorNote(r.error));
      if (!r.result.ok) { checked = null; ledger.replaceChildren(); tray.hidden = true; drawSummary(); return msg.append(note('err', r.result.message)); }
      checked = r.result; drawLedger(); drawTray(); drawSummary();
    }
    const apply = (rows) => { ta.value = S.draft.text = rowsToBatchText(rows); check(); };

    function drawLedger() {
      const c = checked; const bad = c.rows.filter((r) => r.errors.length);
      fill(ledger, h('section', { class: 'card' },
        h('div', { class: 'card-h' }, h('div', null, h('h2', null, `${c.valid} ready`, bad.length ? h('span', { class: 'muted' }, ` · ${bad.length} need attention`) : ''),
          h('div', { class: 'small muted' }, `Total ${fmtZec(c.totalZat)} ${unit()}${c.ignoredColumns?.length ? ` · ignored columns: ${c.ignoredColumns.join(', ')}` : ''}`))),
        h('div', { class: 'tablewrap' }, h('table', { class: 'ledger' },
          h('thead', null, h('tr', null, h('th', { class: 'gutter' }, '#'), h('th', null, 'Recipient'), h('th', null, 'Memo'), h('th', { class: 'amt' }, unit()))),
          h('tbody', null, c.rows.map((r) => h('tr', { class: r.errors.length ? 'bad' : r.warning ? 'dup' : '' },
            h('td', { class: 'gutter' }, r.line),
            h('td', null, r.label ? h('div', { class: 'title' }, r.label) : null,
              h('div', { class: 'addr-line' }, h('span', { class: 'addr', title: r.address }, r.kind ? short(r.address, 16) : r.address), kindPill(r.kind)),
              ...r.errors.map((e) => h('div', { class: 'why' }, icon('alert'), e)), r.warning ? h('div', { class: 'small' }, r.warning) : null),
            h('td', { class: 'small' }, r.memo),
            h('td', { class: 'amt' }, r.amountZec ?? '—'))))))));
    }

    function drawTray() {
      const bad = checked.rows.filter((r) => r.errors.length);
      tray.hidden = false;
      fill(tray, h('span', { class: 'small muted' }, 'Tools'),
        btn('One amount for all', 'xs ghost', () => amountDialog('One amount for everyone', 'Every recipient gets this amount.', (z) => apply(checked.rows.map((r) => rowOut(r, zip321Amount(z))))), 'equal'),
        btn('Split a total', 'xs ghost', () => amountDialog('Split a total evenly', `Divided across ${checked.rows.length} recipients, to the zatoshi.`, (z) => { const parts = splitEvenly(z, checked.rows.length); apply(checked.rows.map((r, i) => rowOut(r, zip321Amount(parts[i])))); }), 'split'),
        bad.length ? btn(`Remove ${bad.length} with problems`, 'xs ghost', () => apply(checked.rows.filter((r) => !r.errors.length).map((r) => rowOut(r))), 'trash') : null,
        btn('Clear', 'xs ghost', () => { ta.value = S.draft.text = ''; check(); }, 'x'));
    }

    function drawSummary() {
      const rowsOk = checked ? checked.rows.filter((r) => !r.errors.length) : [];
      const bad = checked ? checked.rows.length - rowsOk.length : 0;
      const n = rowsOk.length;
      const total = checked ? BigInt(checked.totalZat) : 0n;
      const fee = estimateFeeZat(n);
      const txs = chunkSizes(n).length;
      const spendable = spendableFor(S.draft.fundingPools);
      const remaining = spendable == null ? null : spendable - total - fee;
      const transparent = rowsOk.filter((r) => r.kind === 'transparent').length;
      next.disabled = !checked || bad > 0 || n === 0 || (remaining != null && remaining < 0n);
      fill(summary, 
        h('div', null, h('div', { class: 'big-count num' }, n), h('div', { class: 'muted' }, n === 1 ? 'recipient ready' : 'recipients ready', bad ? h('span', { class: 'small' }, ` · ${bad} need attention`) : '')),
        h('div', { class: 'summary' }, h('dl', null,
          h('dt', null, 'To recipients'), h('dd', null, `${fmtZec(total)} ${unit()}`),
          h('dt', { title: 'ZIP 317: 5,000 zatoshi per recipient, at least 10,000 per transaction. The review shows the exact quote.' }, 'Network fee', h('span', { class: 'faint small' }, '≈')), h('dd', null, `${fmtZec(fee, 4)} ${unit()}`),
          h('dt', null, 'Transactions'), h('dd', null, txs || '—'),
          h('div', { class: 'total' }, h('span', null, 'Total'), h('b', null, `${fmtZec(total + fee)} ${unit()}`)),
          h('dt', { title: 'Payments are funded from shielded pools. Transparent funds need shielding first.' }, S.draft.fundingPools ? `Spendable in ${poolName[S.draft.fundingPools]}` : 'Spendable, shielded'), h('dd', null, spendable == null ? '…' : `${fmtZec(spendable)} ${unit()}`),
          h('dt', null, 'Left after sending'), h('dd', { class: remaining != null && remaining < 0n ? 'neg' : '' }, remaining == null ? '…' : `${fmtZec(remaining)} ${unit()}`))),
        remaining != null && remaining < 0n && n ? note('err', 'Not enough funds', [`Short by ${fmtZec(-remaining)} ${unit()} including the fee.`,
          waitingFor(S.draft.fundingPools) > 0n ? ` ${fmtZec(waitingFor(S.draft.fundingPools))} ${unit()} is still waiting for confirmations.` : '',
          poolZat('transparent', 'spendable') > 0n ? ` ${fmtZec(poolZat('transparent', 'spendable'))} ${unit()} is transparent and cannot fund a private payment until you shield it.` : ''].join('')) : null,
        transparent ? note('warn', `${transparent} transparent recipient${transparent === 1 ? '' : 's'}`, 'Their addresses and amounts will be public. You will be asked to confirm.') : null,
        h('div', { class: 'field' }, h('label', { for: 'pools' }, 'Spend from'), pools),
        next,
        h('p', { class: 'hint' }, `${TX_CHUNK} recipients per transaction, up to 2,000 per batch.`));
    }

    const toReview = async () => {
      next.disabled = true; msg.replaceChildren();
      const ok = checked.rows.filter((r) => !r.errors.length);
      const recipients = ok.map((r) => ({ address: r.address, amountZat: r.amountZat, memo: r.memo || undefined }));
      const fundingPools = S.draft.fundingPools ? [S.draft.fundingPools] : undefined;
      const r = await api('/api/batch/plan', { recipients, fundingPools });
      next.disabled = false;
      if (!r.ok) { msg.append(errorNote(r.error)); msg.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      Object.assign(F, { step: 'review', plan: { ...r.result, recipients, fundingPools }, labels: ok.map((x) => x.label ?? ''), text: ta.value });
      draw();
    };

    const editor = h('section', { class: 'card a-rec' },
        h('div', { class: 'card-h' }, h('h2', null, 'Recipients'),
          h('div', { class: 'toolbar' },
            h('label', { class: 'btn xs ghost', for: 'file' }, icon('upload'), 'Import CSV'), file,
            btn('Contacts', 'xs ghost', () => pickContacts(), 'contacts'),
            btn('Lists', 'xs ghost', () => pickList(), 'lists'),
            btn('Save as list', 'xs ghost', () => saveAsList(), 'plus'))),
        h('div', { class: 'stack' }, ta, tray, h('div', { class: 'row' }, btn('Check recipients', 'sm', check, 'check'), h('span', { class: 'hint' }, 'Devoid checks as you type.')), msg));
    ledger.className = 'a-led';
    queueMicrotask(() => {
      drawSummary();
      if (S.draft.text.trim()) check();
      if (S.openImport) { S.openImport = false; file.click(); }
    });

    async function pickContacts() {
      if (!S.lists) await loadLists();
      const contacts = S.lists?.contacts ?? [];
      const sel = new Set();
      modal('Add from contacts', (close) => {
        if (!contacts.length) return emptyState('contacts', 'No contacts yet', 'Save the people you pay often in Contacts.', btn('Open contacts', 'sm', () => { close(); nav.go('contacts'); }));
        const search = h('input', { type: 'search', placeholder: 'Search by name or address', 'aria-label': 'Search contacts' });
        const add = btn('Add to batch', 'block', async () => { await appendRecipients(contacts.filter((c) => sel.has(c.id)).map((c) => ({ address: c.address, amount: '', label: c.name }))); close(); ta.value = S.draft.text; check(); toast(`${sel.size} added. Set their amounts, or use “One amount for all”.`); });
        add.disabled = true;
        const list = h('div', { class: 'pick' });
        const drawList = () => {
          const q = search.value.trim().toLowerCase();
          fill(list, ...contacts.filter((c) => !q || c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q)).map((c) => {
            const cb = h('input', { type: 'checkbox', checked: sel.has(c.id), onchange: (e) => { if (e.target.checked) sel.add(c.id); else sel.delete(c.id); add.disabled = !sel.size; add.lastChild.textContent = sel.size ? `Add ${sel.size} to batch` : 'Add to batch'; } });
            return h('label', null, cb, h('span', { class: 'avatar', vars: { '--h': hueOf(c.name) } }, monogram(c.name)), h('span', null, h('div', { class: 'title' }, c.name), h('div', { class: 'mono faint' }, short(c.address, 12))));
          }));
        };
        search.addEventListener('input', drawList); drawList();
        return h('div', { class: 'stack' }, search, list, add);
      });
    }

    async function pickList() {
      if (!S.lists) await loadLists();
      const lists = S.lists?.lists ?? [];
      modal('Use a saved list', (close) => {
        if (!lists.length) return emptyState('lists', 'No saved lists', 'Paste recipients here, then choose “Save as list”.');
        return h('div', { class: 'items' }, lists.map((l) => h('div', { class: 'item' }, h('span', { class: 'tile-ico' }, icon('lists')),
          h('div', null, h('div', { class: 'title' }, l.name), h('div', { class: 'meta' }, `Saved ${new Date(l.updated).toLocaleDateString()}`)),
          h('div', { class: 'row nowrap' },
            S.draft.text.trim() ? btn('Add', 'xs ghost', async () => { const v = await api('/api/batch/validate', { text: l.text }); if (v.ok && v.result.ok) await appendRecipients(v.result.rows.map((x) => rowOut(x))); close(); ta.value = S.draft.text; check(); }) : null,
            btn(S.draft.text.trim() ? 'Replace' : 'Use', 'xs', () => { ta.value = S.draft.text = l.text; close(); check(); })))));
      });
    }

    async function saveAsList() {
      if (!ta.value.trim()) return toast('Add some recipients first.', 'info');
      if (!S.lists) await loadLists();
      modal('Save as list', (close) => {
        const name = h('input', { type: 'text', 'aria-label': 'List name', placeholder: 'For example: October payroll', maxlength: '80' });
        const save = btn('Save list', 'block', async () => {
          if (!name.value.trim()) return name.focus();
          const r = await saveLists({ lists: [...(S.lists?.lists ?? []), { id: crypto.randomUUID(), name: name.value.trim().slice(0, 80), text: ta.value, updated: Date.now() }] });
          close(); toast(r.ok ? 'List saved' : 'Could not save the list', r.ok ? 'check' : 'alert');
        });
        name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
        queueMicrotask(() => name.focus());
        return h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Reuse it for recurring payments: payroll, grants, DAO payouts.'), name, save);
      });
    }

    // On a phone the summary, with its Review button, sits between the editor and the table.
    return h('div', { class: 'grid g-send' }, editor, h('aside', { class: 'card sticky a-sum' }, summary), ledger);
  }

  function amountDialog(title, hint, onApply) {
    modal(title, (close) => {
      const input = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': `Amount in ${unit()}` });
      const err = h('div');
      const ok = btn('Apply', 'block', () => {
        const z = parseZecToZat(input.value);
        if (z == null || z <= 0n) { fill(err, errorNote({ message: 'Enter an amount like 0.25, with at most 8 decimals.' })); return; }
        close(); onApply(z);
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
      queueMicrotask(() => input.focus());
      return h('div', { class: 'stack' }, h('p', { class: 'muted small' }, hint), h('div', { class: 'suffix-wrap' }, input, h('span', { class: 'suffix' }, unit())), err, ok);
    });
  }

  // ---- review --------------------------------------------------------------------------------
  function review() {
    const plan = F.plan; const f = plan.first; const need = plan.needsAck;
    const acks = new Set(); const err = h('div');
    const sum = plan.recipients.reduce((a, r) => a + BigInt(r.amountZat), 0n);
    const n = plan.recipients.length;
    const pass = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', placeholder: 'Your wallet passphrase' });
    const sendBtn = btn('Confirm and send', 'lg block', async () => {
      err.replaceChildren();
      if (!pass.value) { err.append(errorNote({ message: 'Enter your passphrase to sign.' })); return pass.focus(); }
      sendBtn.disabled = true;
      const r = await api('/api/batch/send', { recipients: plan.recipients, fundingPools: plan.fundingPools, passphrase: pass.value, acknowledge: [...acks] });
      pass.value = '';
      if (!r.ok) { sendBtn.disabled = false; return err.append(errorNote(r.error)); }
      Object.assign(F, { step: 'sending', jobId: r.result.jobId, job: null });
      draw();
    }, 'lock', { id: 'confirm' });
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !sendBtn.disabled) sendBtn.click(); });
    const sync = () => { sendBtn.disabled = need.some((x) => !acks.has(x)); };
    const labels = { transparent_recipient: 'I understand the transparent payments and their amounts will be public.', pool_crossing: 'I understand that the amount moving between pools will be public.' };
    const level = f.privacy.level;
    const levelView = level === 'private'
      ? h('div', { class: 'privacy-level' }, h('span', { class: 'tile-ico received' }, icon('shielded')), h('div', null, h('b', null, 'Fully shielded'), h('div', { class: 'small muted' }, 'Recipients, amounts and memos stay hidden. The chain only shows that a transaction happened, and roughly how big it is.')))
      : h('div', { class: 'privacy-level' }, h('span', { class: 'tile-ico public' }, icon('shieldAlert')), h('div', null, h('b', null, level === 'public' ? 'Some of this will be public' : 'Part of this will be visible'), h('div', { class: 'small muted' }, 'Read what is exposed below before you confirm.')));
    queueMicrotask(sync);
    return h('div', { class: 'sheet stack-lg' },
      h('section', { class: 'card pad-lg' },
        h('div', { class: 'sheet-head' }, h('h2', null, 'Confirm payment'), h('p', null, 'Check every detail. Sent payments cannot be reversed.'),
          h('div', { class: 'amount-xl', id: 'review-total' }, fmtZec(sum), h('small', null, unit())),
          h('p', null, `to ${n} recipient${n === 1 ? '' : 's'}${plan.transactions > 1 ? ` in ${plan.transactions} transactions` : ''}`)),
        h('div', { class: 'facts' },
          h('div', null, h('span', { class: 'k' }, icon('wallet'), 'From'), h('span', { class: 'v' }, 'This wallet', h('span', { class: 'sub2' }, f.fundingPools.map((p) => poolName[p]).join(' + ')))),
          h('div', null, h('span', { class: 'k' }, icon('globe'), 'Network'), h('span', { class: 'v' }, h('span', { class: `pill ${isTest() ? 'test' : ''}` }, isTest() ? 'Testnet' : 'Mainnet'))),
          h('div', null, h('span', { class: 'k' }, icon('users'), 'Recipients'), h('span', { class: 'v' }, n)),
          h('div', null, h('span', { class: 'k' }, icon('coins'), plan.feeIsEstimate ? 'Network fees' : 'Network fee'), h('span', { class: 'v' }, `${fmtZec(plan.estimatedFeeZat, 4)} ${unit()}`, h('span', { class: 'sub2' }, plan.feeIsEstimate ? 'First transaction quoted, later ones estimated' : 'Quoted by the engine'))),
          h('div', { class: 'total' }, h('span', { class: 'k' }, 'Total'), h('span', { class: 'v' }, `${fmtZec(sum + BigInt(plan.estimatedFeeZat))} ${unit()}`))),
        h('details', { class: 'more facts' }, h('summary', null, `See all ${n} recipient${n === 1 ? '' : 's'}`, icon('chevronDown')),
          h('div', { class: 'recips' }, plan.recipients.map((r, i) => h('div', { class: 'r' }, h('span', { class: 'faint num' }, i + 1),
            h('span', null, F.labels?.[i] ? h('div', { class: 'title small' }, F.labels[i]) : null, h('span', { class: 'mono' }, short(r.address, 14)), r.memo ? h('div', { class: 'faint' }, `“${r.memo}”`) : null),
            h('b', { class: 'num' }, fmtZec(r.amountZat))))))),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'What others can see')),
        h('div', { class: 'stack' }, levelView,
          ...f.privacy.findings.filter((x) => x.code !== 'shape_visible').map((x) => note(x.severity === 'info' ? 'info' : 'warn', null, x.message)),
          ...need.map((code) => h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) acks.add(code); else acks.delete(code); sync(); } }), labels[code] ?? code)),
          plan.sequential ? note('info', `Sent as ${plan.transactions} transactions, in order`, `Each pays up to ${plan.chunkSize} people. Later ones spend change from earlier ones, so Devoid waits for confirmations between them. Keep this window open.`) : null)),
      h('section', { class: 'card' }, h('div', { class: 'stack' },
        h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Passphrase'), pass, h('span', { class: 'hint' }, 'Used once to sign, never stored.')),
        err, sendBtn, btn('Back to recipients', 'ghost block', () => { F.step = 'compose'; draw(); }, 'arrowLeft'))));
  }

  // ---- sending / sent / stopped ---------------------------------------------------------------
  function receipt(job) {
    const plan = F.plan; const per = chunkSizes(plan.recipients.length).length;
    const rows = plan.recipients.map((r, i) => {
      const chunk = Math.floor(i / TX_CHUNK);
      const sent = chunk < (job.done ?? 0);
      const txid = !sent ? '' : job.txids.length === per ? job.txids[chunk] : job.txids.join(' ');
      return [i + 1, r.address, F.labels?.[i] ?? '', zip321Amount(r.amountZat), r.memo ?? '', chunk + 1, sent ? 'sent' : 'not sent', txid];
    });
    download(`devoid-receipt-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, toCsv(['line', 'address', 'label', `amount_${unit().toLowerCase()}`, 'memo', 'transaction', 'status', 'txid'], rows, ['line', `amount_${unit().toLowerCase()}`, 'transaction']));
  }

  function result() {
    const body = h('div', { class: 'stack-lg' });
    const card = h('section', { class: 'card pad-lg' }, body);
    const sum = F.plan.recipients.reduce((a, r) => a + BigInt(r.amountZat), 0n);
    const txList = (ids) => h('div', { class: 'stack' }, ids.map((t, i) => h('div', { class: 'txid' }, h('span', { class: 'n faint' }, ids.length > 1 ? `${i + 1}` : 'ID'), h('span', { class: 'id', title: t }, t), btn('Copy', 'xs ghost', () => copy(t, 'Transaction ID copied'), 'copy'))));
    const newBatch = () => { S.sendFlow = { step: 'compose' }; S.draft.text = ''; restart(); };

    const paint = (j) => {
      if (!j || j.state === 'running') {
        const pct = j ? Math.round((j.done / j.total) * 100) : 0;
        const bar = h('i'); bar.style.width = `${Math.max(pct, 4)}%`;
        fill(body, h('div', { class: 'result' }, h('div', { class: 'badge-ring busy' }, h('span', { class: 'spin' }, icon('spin'))),
          h('h2', null, 'Sending'), h('p', { class: 'muted' }, j?.total > 1 ? `Transaction ${j.current} of ${j.total}` : 'Building, proving and broadcasting'),
          h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar),
          h('p', { class: 'small muted' }, j?.message ?? 'Starting…')),
          j?.total > 1 ? note('info', 'Keep this window open', 'Later transactions wait for change from earlier ones to confirm.') : null);
        return;
      }
      if (j.state === 'done') {
        fill(body, h('div', { class: 'result' },
          h('div', { class: 'badge-ring info' }, icon('send')),
          h('span', { class: 'pill info lg' }, icon('clock'), 'Broadcast · waiting to be mined'),
          h('div', { class: 'amount-xl', id: 'sent-total' }, fmtZec(sum), h('small', null, unit())),
          h('p', { class: 'muted' }, `${F.plan.recipients.length} recipient${F.plan.recipients.length === 1 ? '' : 's'} · ${j.txids.length} transaction${j.txids.length === 1 ? '' : 's'} sent to the network. They confirm in Activity once mined.`)),
          txList(j.txids),
          h('div', { class: 'row' }, btn('Download receipt', 'ghost', () => receipt(j), 'download', { id: 'receipt' }), btn('Send again', 'ghost', () => { S.draft.text = F.text; S.sendFlow = { step: 'compose' }; restart(); }, 'repeat'),
            h('span', { class: 'spacer' }), btn('View activity', '', () => nav.go('activity'), 'activity')),
          h('div', { class: 'row' }, btn('Start a new batch', 'ghost sm', newBatch, 'plus')));
        return;
      }
      fill(body, h('div', { class: 'result' }, h('div', { class: 'badge-ring fail' }, icon('fail')), h('h2', null, 'Sending stopped'), h('p', { class: 'muted' }, j.message)),
        errorNote(j.error),
        j.txids.length ? h('div', { class: 'stack' }, note('warn', `${j.done} of ${j.total} transactions went out`, 'Those recipients are paid and that cannot be undone. The receipt marks who was paid and who was not, so you can send the rest.'), txList(j.txids)) : null,
        h('div', { class: 'row' }, j.txids.length ? btn('Download receipt', 'ghost', () => receipt(j), 'download') : null,
          btn('Back to recipients', 'ghost', () => { F.step = 'compose'; draw(); }, 'arrowLeft'), h('span', { class: 'spacer' }), btn('Check activity', '', () => nav.go('activity'), 'activity')));
    };

    if (F.job && F.job.state !== 'running') { paint(F.job); return card; }
    paint(F.job);
    (async () => {
      while (S.view === 'send' && S.sendFlow === F) {
        const r = await api('/api/batch/job', { jobId: F.jobId });
        if (!r.ok) { fill(body, errorNote(r.error)); return; }
        F.job = r.result; paint(F.job);
        if (F.job.state !== 'running') { F.step = F.job.state === 'done' ? 'done' : 'failed'; if (F.job.state === 'done') { S.draft.text = ''; nav.refresh(false); } refreshSteps(); return; }
        await new Promise((res) => setTimeout(res, 1200));
      }
    })();
    return card;
  }
  function refreshSteps() {
    const li = el.querySelectorAll('.steps li');
    li.forEach((x, i) => { x.className = i < 2 || F.step === 'done' ? 'done' : ''; x.removeAttribute('aria-current'); });
    if (F.step !== 'done') li[2]?.setAttribute('aria-current', 'step');
  }

  draw();
}
