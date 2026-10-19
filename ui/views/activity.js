// Activity: payments grouped by day, filterable, with every output on demand and a CSV export.
import { api, h, btn, copy, download, sens, unit, note, emptyState, when, timeOf, short, poolName, fill } from '../lib.js';
import { icon } from '../icons.js';
import { fmtZec, dayLabel, toCsv } from '../calc.js';

const KIND = {
  sent: { ic: 'sent', label: 'Sent' }, received: { ic: 'received', label: 'Received' },
  shielded: { ic: 'shielded', label: 'Shielded funds' }, internal: { ic: 'internal', label: 'Moved between pools' },
};

function title(t) {
  if (t.status === 'expired') return t.kind === 'shielded' ? 'Shielding expired' : 'Payment expired';
  if (t.kind === 'sent') return t.sentOutputs > 1 ? `Sent to ${t.sentOutputs} recipients` : 'Sent';
  return (KIND[t.kind] ?? { label: t.kind }).label;
}

export function statusPill(t) {
  if (t.status === 'pending') return h('span', { class: 'pill pending' }, icon('clock'), 'Pending');
  if (t.status === 'expired') return h('span', { class: 'pill fail' }, icon('fail'), 'Expired');
  const n = t.confirmations ?? 0;
  return h('span', { class: 'pill ok' }, icon('ok'), `${n.toLocaleString()} confirmation${n === 1 ? '' : 's'}`);
}

function tile(t) {
  const fail = t.status === 'expired';
  return h('span', { class: `tile-ico ${fail ? 'fail' : t.kind}` }, icon(fail ? 'fail' : (KIND[t.kind]?.ic ?? 'check')));
}

function amount(t) {
  const d = BigInt(t.balanceDeltaZat);
  // An expired transaction never spent anything; showing its would-be delta as a loss would lie.
  if (t.status === 'expired') return h('span', { class: 'amt faint' }, `${fmtZec(-d)} ${unit()}`);
  return sens(`${d > 0n ? '+' : ''}${fmtZec(d)} ${unit()}`, `amt ${d > 0n ? 'in' : ''}`);
}

// A transaction with no block yet is either on its way or, once expired, never going to be mined.
const unmined = (t) => (t.status === 'expired' ? 'Never mined, nothing spent' : 'Waiting to be mined');

/** A compact row for the overview. */
export function txItem(t) {
  return h('div', { class: 'item' }, tile(t),
    h('div', null, h('div', { class: 'title' }, title(t)), h('div', { class: 'meta' }, t.blockTime ? when(t.blockTime) : unmined(t), statusPill(t))),
    amount(t));
}

function txRow(t) {
  const detail = h('div', { class: 'detail', hidden: true });
  const toggle = h('button', { type: 'button', 'aria-expanded': 'false', onclick: () => { const open = detail.hidden; detail.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); if (open && !detail.childNodes.length) fillDetail(); } },
    tile(t),
    h('span', { class: 'tline' }, h('span', { class: 'title' }, title(t)), h('span', { class: 'meta' }, t.blockTime ? timeOf(t.blockTime) : unmined(t), statusPill(t))),
    amount(t), h('span', { class: 'chev' }, icon('chevronRight')));
  function fillDetail() {
    const outs = (t.outputs ?? []).filter((o) => !o.isChange);
    fill(detail,
      t.status === 'expired' ? note('err', 'This transaction expired before it was mined.', 'Nothing was spent: the funds it would have used are back in your balance. Send again if you still need to.') : null,
      t.status === 'pending' ? note('info', 'Broadcast, waiting to be mined.', t.expiryHeight ? `If it is not mined by block ${t.expiryHeight.toLocaleString()}, it expires and the funds return to you.` : null) : null,
      h('dl', { class: 'kv' },
        h('dt', null, 'Transaction'), h('dd', null, h('div', { class: 'row nowrap' }, h('span', { class: 'mono break' }, t.txid), btn('Copy', 'xs ghost', () => copy(t.txid, 'Transaction ID copied'), 'copy'))),
        h('dt', null, 'Date'), h('dd', null, when(t.blockTime)),
        t.minedHeight ? [h('dt', null, 'Block'), h('dd', { class: 'num' }, t.minedHeight.toLocaleString())] : null,
        t.feeZat != null ? [h('dt', null, 'Network fee'), h('dd', { class: 'num' }, `${fmtZec(t.feeZat, 4)} ${unit()}`)] : null),
      t.poolCrossingZat ? note('warn', `${fmtZec(t.poolCrossingZat)} ${unit()} crossed between pools`, 'That amount is visible on the chain. Recipients and memos stay private.') : null,
      outs.length ? h('div', null, h('div', { class: 'label' }, `Outputs (${outs.length})`), h('div', null, outs.map((o) => h('div', { class: 'out-row' },
        h('div', null, h('div', { class: 'mono' }, o.address ? short(o.address, 14) : 'To you'), h('div', { class: 'tags' },
          h('span', { class: `pill ${o.pool === 'transparent' ? 'public' : 'ok'}` }, poolName[o.pool] ?? o.pool), o.memo ? h('span', { class: 'small muted' }, `“${o.memo}”`) : null)),
        sens(`${fmtZec(o.valueZat)} ${unit()}`, 'amt'))))) : null);
  }
  return h('div', { class: 'tx' }, toggle, detail);
}

const FILTERS = [['all', 'All'], ['sent', 'Sent'], ['received', 'Received'], ['pending', 'Pending'], ['expired', 'Failed']];
const match = (f, t) => f === 'all' || (f === 'pending' || f === 'expired' ? t.status === f : (f === 'sent' ? ['sent', 'shielded', 'internal'].includes(t.kind) : t.kind === f));

export async function viewActivity(el) {
  let filter = 'all'; let offset = 0; let hasMore = false; const txs = [];
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' });
  const list = h('div'); const more = h('div', { class: 'row pad-top' });
  const exportBtn = btn('Export CSV', 'ghost sm', () => exportAll(), 'download');
  el.append(h('div', { class: 'stack-lg' }, h('div', { class: 'row between' }, chips, exportBtn), h('section', { class: 'card' }, list, more)));

  const drawChips = () => fill(chips, ...FILTERS.map(([id, label]) => {
    const n = txs.filter((t) => match(id, t)).length;
    return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filter === id), onclick: () => { filter = id; draw(); } }, label, id !== 'all' && n ? h('span', { class: 'count' }, n) : null);
  }));
  const draw = () => {
    drawChips();
    const shown = txs.filter((t) => match(filter, t));
    if (!shown.length) {
      fill(list, txs.length ? emptyState('search', 'Nothing here', 'No payments match this filter.') : emptyState('activity', 'No activity yet', 'Receive some ZEC, or send your first batch.'));
    } else {
      const groups = new Map();
      for (const t of shown) { const k = t.status === 'pending' ? 'Pending' : dayLabel(t.blockTime); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
      fill(list, ...[...groups].flatMap(([day, ts]) => [h('div', { class: 'day' }, day), ...ts.map(txRow)]));
    }
    fill(more, hasMore ? btn('Load more', 'ghost sm', load) : '');
  };
  async function load() {
    const r = await api('/api/engine/history', { limit: 50, offset, outputs: true });
    if (!r.ok) { fill(list, note('err', r.error.message)); return; }
    txs.push(...r.result.transactions); offset += r.result.transactions.length; hasMore = r.result.hasMore;
    draw();
  }
  async function exportAll() {
    exportBtn.disabled = true;
    const all = []; let off = 0;
    for (;;) {
      const r = await api('/api/engine/history', { limit: 200, offset: off, outputs: true });
      if (!r.ok) { exportBtn.disabled = false; return list.prepend(note('err', r.error.message)); }
      all.push(...r.result.transactions); off += r.result.transactions.length;
      if (!r.result.hasMore || !r.result.transactions.length) break;
    }
    const rows = all.map((t) => [t.blockTime ? new Date(t.blockTime * 1000).toISOString() : '', t.kind, t.status, t.confirmations ?? '', fmtZec(t.balanceDeltaZat, 0).replace(/,/g, ''), t.feeZat != null ? fmtZec(t.feeZat, 0) : '', t.sentOutputs ?? '', (t.outputs ?? []).filter((o) => o.memo && !o.isChange).map((o) => o.memo).join(' | '), t.txid]);
    download(`devoid-activity-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(['date', 'type', 'status', 'confirmations', `amount_${unit().toLowerCase()}`, 'fee', 'recipients', 'memos', 'txid'], rows, ['confirmations', `amount_${unit().toLowerCase()}`, 'fee', 'recipients']));
    exportBtn.disabled = false;
  }
  list.append(h('div', { class: 'stack' }, [1, 2, 3].map(() => h('div', { class: 'skel' }))));
  await load();
}
