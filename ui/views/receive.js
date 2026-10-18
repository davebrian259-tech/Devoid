// Receive: one address at a time with its QR, fresh shielded addresses, and ZIP 321 payment
// requests that carry the amount and memo for the payer's wallet.
import { S, api, h, btn, copy, note, modal, unit, errorNote, fill } from '../lib.js';
import { icon } from '../icons.js';
import { qrSvgPath } from '../qr.js';
import { parseZecToZat, zip321Uri } from '../calc.js';

const NS = 'http://www.w3.org/2000/svg';

export function qrFor(text, label) {
  const { size, d } = qrSvgPath(text);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('class', 'qr'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p);
  return h('div', { class: 'qr-frame' }, svg);
}

const TYPES = {
  shielded: { label: 'Shielded', tag: ['ok', 'shielded', 'Private'], note: ['ok', 'Best for privacy', 'A unified address. Who pays you, and how much, stays hidden. Funds land in the newest shielded pool.'] },
  sapling: { label: 'Sapling', tag: ['ok', 'shielded', 'Private'], note: ['info', 'For older wallets', 'Use this only if the sender’s wallet cannot pay a unified address yet. Still shielded.'] },
  transparent: { label: 'Transparent', tag: ['public', 'eye', 'Public'], note: ['warn', 'Everything sent here is public', 'Like Bitcoin: anyone can see the address and amounts. Shield these funds afterwards in Settings.'] },
};

export async function viewReceive(el) {
  const r = await api('/api/engine/addresses');
  if (!r.ok) return el.append(errorNote(r.error));
  const addrs = { ...r.result };
  let type = 'shielded';
  const card = h('section', { class: 'card pad-lg receive' });
  el.append(card);

  const draw = () => {
    const t = TYPES[type]; const addr = addrs[type];
    fill(card, 
      h('div', { class: 'seg block', role: 'group', 'aria-label': 'Address type' }, Object.entries(TYPES).map(([k, v]) =>
        h('button', { type: 'button', 'aria-pressed': String(k === type), onclick: () => { type = k; draw(); } }, v.label))),
      qrFor(addr, `QR code for your ${t.label.toLowerCase()} address`),
      h('div', { class: 'stack' },
        h('div', { class: 'row between' }, h('span', { class: 'label' }, `Your ${t.label.toLowerCase()} address`), h('span', { class: `pill ${t.tag[0]}` }, icon(t.tag[1]), t.tag[2])),
        h('div', { class: 'addr-box', id: 'addr' }, addr),
        h('div', { class: 'row' }, btn('Copy address', 'block', () => copy(addr, 'Address copied'), 'copy', { id: 'copy-addr' })),
        h('div', { class: 'row' },
          type === 'shielded' ? btn('New address', 'ghost sm', async () => {
            const n = await api('/api/engine/newAddress');
            if (!n.ok) return card.append(errorNote(n.error));
            addrs.shielded = n.result.shielded; draw();
          }, 'refresh', { title: 'Same wallet, different address. Use one per contact so payments cannot be linked by address.' }) : null,
          btn('Request payment', 'ghost sm', () => request(addr, type), 'qr', { id: 'request' })),
        note(...t.note)));
  };
  draw();
  if (S.openRequest) { S.openRequest = false; request(addrs.shielded, 'shielded'); }
}

function request(address, type) {
  modal('Request a payment', () => {
    const amount = h('input', { type: 'text', inputmode: 'decimal', id: 'req-amount', placeholder: '0.00', 'aria-label': `Amount in ${unit()}` });
    const memo = h('input', { type: 'text', id: 'req-memo', maxlength: '200', placeholder: 'Invoice 42' });
    const message = h('input', { type: 'text', id: 'req-msg', maxlength: '120', placeholder: 'Thanks!' });
    const out = h('div', { class: 'stack' });
    const update = () => {
      const z = amount.value.trim() ? parseZecToZat(amount.value) : null;
      if (amount.value.trim() && z == null) { fill(out, errorNote({ message: 'Enter an amount like 0.25, with at most 8 decimals.' })); return; }
      if (new TextEncoder().encode(memo.value).length > 512) { fill(out, errorNote({ message: 'A memo can hold at most 512 bytes.' })); return; }
      const uri = zip321Uri({ address, amountZat: z, memo: type === 'transparent' ? '' : memo.value.trim(), message: message.value.trim() });
      fill(out, qrFor(uri, 'QR code for this payment request'), h('div', { class: 'addr-box short uri', id: 'req-uri' }, uri),
        btn('Copy request link', 'block', () => copy(uri, 'Payment request copied'), 'copy'));
    };
    for (const i of [amount, memo, message]) i.addEventListener('input', update);
    update();
    queueMicrotask(() => amount.focus());
    return h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'A ZIP 321 link: Zcash wallets that scan it fill in the address, amount and memo for the payer.'),
      h('div', { class: 'g-2 grid' },
        h('div', { class: 'field' }, h('label', { for: 'req-amount' }, 'Amount'), h('div', { class: 'suffix-wrap' }, amount, h('span', { class: 'suffix' }, unit()))),
        h('div', { class: 'field' }, h('label', { for: 'req-msg' }, 'Message'), message)),
      type === 'transparent' ? note('warn', 'Transparent addresses cannot receive a memo.') : h('div', { class: 'field' }, h('label', { for: 'req-memo' }, 'Memo'), memo, h('span', { class: 'hint' }, 'Encrypted: only you and the payer can read it.')),
      out);
  });
}
