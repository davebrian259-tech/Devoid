// Overview: balance behind its redaction bar, where the money sits, people to pay, recent activity.
import { S, nav, api, h, btn, sens, unit, emptyState, loadLists, note, poolName, fill } from '../lib.js';
import { icon } from '../icons.js';
import { fmtZec, monogram, hueOf } from '../calc.js';
import { txItem } from './activity.js';
import { appendRecipients } from './send.js';

const POOLS = ['ironwood', 'orchard', 'sapling', 'transparent'];

export function viewHome(el) {
  const figure = h('span', { class: 'figure' }, '—');
  // data-overlap-ok: the bar covers the balance and carries "Tap to reveal" on top of it by design.
  const redact = h('button', { class: 'redact', type: 'button', 'data-overlap-ok': true, 'aria-pressed': String(S.revealed), 'aria-label': 'Spendable balance. Press to show or hide balances.', onclick: () => nav.setReveal(!S.revealed) },
    figure, h('span', { class: 'unit' }, unit()), h('span', { class: 'bar' }), h('span', { class: 'hint-tap' }, icon('eye'), 'Tap to reveal'));
  const meta = h('div', { class: 'balance-meta' });
  const share = h('span', { class: 'pill' });
  const quick = h('div', { class: 'quick' },
    [['send', 'Send', () => nav.go('send'), 'primary'], ['receive', 'Receive', () => nav.go('receive')], ['qr', 'Request', () => { S.openRequest = true; nav.go('receive'); }], ['upload', 'Import', () => { S.openImport = true; nav.go('send'); }]]
      .map(([ic, label, onclick, cls]) => h('button', { type: 'button', class: cls ?? '', onclick }, h('span', { class: 'tile' }, icon(ic)), label)));
  const balanceCard = h('section', { class: 'card dark pad-lg balance-card' },
    h('div', { class: 'balance-top' }, h('span', { class: 'eyebrow' }, icon('wallet'), 'Spendable balance'), share),
    redact, meta, h('hr', { class: 'divider' }), quick);

  const poolsBody = h('div');
  const poolsCard = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Where your money sits'), h('span', { class: 'shield-score', id: 'score' })), poolsBody);

  const people = h('div', { class: 'people' });
  const peopleCard = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Pay someone'), h('button', { class: 'link', type: 'button', onclick: () => nav.go('contacts') }, 'All contacts', icon('chevronRight'))), people);

  const recent = h('div', { class: 'items' }, [1, 2, 3, 4].map(() => h('div', { class: 'item' }, h('div', { class: 'skel tile-ico' }), h('div', { class: 'stack' }, h('div', { class: 'skel' }), h('div', { class: 'skel' })), h('div'))));
  const recentCard = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Recent activity'), h('button', { class: 'link', type: 'button', onclick: () => nav.go('activity') }, 'See all', icon('chevronRight'))), recent);

  const listsBody = h('div', { class: 'items' });
  const listsCard = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Saved lists'), h('button', { class: 'link', type: 'button', onclick: () => nav.go('lists') }, 'Manage', icon('chevronRight'))), listsBody);

  el.append(h('div', { class: 'grid g-main' },
    h('div', { class: 'stack-lg' }, balanceCard, poolsCard, peopleCard),
    h('div', { class: 'stack-lg' }, recentCard, listsCard)));

  function paint() {
    const b = S.balance;
    figure.textContent = b ? fmtZec(b.spendable) : '—';
    const parts = [];
    if (S.syncing) parts.push(h('span', null, icon('refresh'), 'Syncing…'));
    else if (b) parts.push(h('span', null, h('span', { class: 'dot' }), b.scanFraction < 1 ? `Scanning ${(b.scanFraction * 100).toFixed(1)}%` : `Synced to block ${b.chainHeight.toLocaleString()}`));
    if (b && BigInt(b.pendingReceived) + BigInt(b.pendingChange) > 0n) parts.push(h('span', null, icon('clock'), sens(`${fmtZec(BigInt(b.pendingReceived) + BigInt(b.pendingChange))} ${unit()}`), ' arriving'));
    if (b && BigInt(b.total) > BigInt(b.spendable)) parts.push(h('span', null, 'Total ', sens(`${fmtZec(b.total)} ${unit()}`)));
    fill(meta, ...parts);
    if (!b) return;

    const tot = (k) => BigInt(b.pools[k]?.total ?? 0);
    const all = POOLS.reduce((a, k) => a + tot(k), 0n);
    const shielded = all - tot('transparent');
    const pct = all > 0n ? Number((shielded * 1000n) / all) / 10 : null;
    share.className = `pill ${pct === null ? '' : pct === 100 ? 'ok' : 'public'}`;
    fill(share, icon(pct === 100 || pct === null ? 'shielded' : 'shieldAlert'), pct === null ? 'Nothing yet' : pct === 100 ? 'Fully shielded' : `${pct}% shielded`);
    document.getElementById('score')?.replaceChildren(...(pct === null ? [] : [h('b', null, `${pct}%`), h('span', { class: 'small muted' }, 'shielded')]));

    if (all === 0n) {
      fill(poolsBody, emptyState('coins', 'No funds yet', 'Receive ZEC to your shielded address to get started.', btn('Receive', 'sm', () => nav.go('receive'), 'receive')));
      return;
    }
    const bar = h('div', { class: 'poolbar', role: 'img', 'aria-label': POOLS.filter((k) => tot(k) > 0n).map((k) => `${poolName[k]} ${Number((tot(k) * 1000n) / all) / 10}%`).join(', ') });
    for (const k of POOLS) if (tot(k) > 0n) { const seg = h('i', { class: `p-${k}` }); seg.style.flexGrow = String(Number((tot(k) * 10000n) / all)); bar.append(seg); }
    const legend = h('div', { class: 'legend' }, POOLS.filter((k) => tot(k) > 0n).map((k) => h('div', null, h('span', { class: `sw p-${k}` }),
      h('span', null, poolName[k], ' ', h('span', { class: 'faint small' }, k === 'transparent' ? 'public' : 'private')), sens(`${fmtZec(tot(k))} ${unit()}`, 'amt'))));
    fill(poolsBody, bar, legend,
      tot('transparent') > 0n ? h('div', { class: 'stack' }, h('div'), note('warn', 'Some of your balance is transparent', 'Anyone can see transparent funds. Shield them to spend privately.'),
        h('div', null, btn('Shield it', 'sm', () => { S.focusShield = true; nav.go('settings'); }, 'shielded'))) : null);
  }
  S.onBalance = paint;
  paint();

  (async () => {
    if (!S.lists) await loadLists();
    const contacts = S.lists?.contacts ?? [];
    fill(people, 
      h('button', { class: 'person add', type: 'button', onclick: () => nav.go('contacts') }, h('span', { class: 'avatar' }, icon('userPlus')), h('span', { class: 'n' }, 'Add')),
      ...contacts.slice(0, 12).map((c) => h('button', { class: 'person', type: 'button', title: `Add ${c.name} to a batch`, onclick: async () => { await appendRecipients([{ address: c.address, amount: '', label: c.name }]); nav.go('send'); } },
        h('span', { class: 'avatar', vars: { '--h': hueOf(c.name) } }, monogram(c.name)), h('span', { class: 'n' }, c.name))));
    if (!contacts.length) people.append(h('p', { class: 'small muted' }, 'Save the people you pay often, then add them to a batch in one tap.'));

    const lists = [...(S.lists?.lists ?? [])].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, 3);
    fill(listsBody, ...(lists.length ? lists.map((l) => {
      const n = l.text.split(/\r?\n/).filter((x) => x.trim() && !/^\s*"?address/i.test(x)).length;
      return h('div', { class: 'item' }, h('span', { class: 'tile-ico' }, icon('lists')), h('div', null, h('div', { class: 'title' }, l.name), h('div', { class: 'meta' }, `${n} recipient${n === 1 ? '' : 's'}`)),
        btn('Use', 'xs', () => { S.draft.text = l.text; nav.go('send'); }));
    }) : [emptyState('lists', 'No saved lists', 'Save a batch as a list to reuse it for payroll or grants.')]));
  })();

  (async () => {
    const r = await api('/api/engine/history', { limit: 6 });
    if (!r.ok) return fill(recent, note('err', r.error.message));
    const txs = r.result.transactions;
    fill(recent, ...(txs.length ? txs.map((t) => txItem(t)) : [emptyState('activity', 'No activity yet', 'Receive some ZEC, or send your first batch.')]));
  })();
}
