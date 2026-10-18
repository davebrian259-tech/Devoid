// Contacts: an address book on this computer. Every address is checked against the wallet's
// network before it is saved, and any contact goes into a batch in one tap.
import { S, nav, api, h, btn, modal, confirmDialog, toast, short, emptyState, errorNote, saveLists, loadLists, iconBtn, fill } from '../lib.js';
import { monogram, hueOf, csvCell } from '../calc.js';
import { appendRecipients } from './send.js';

const KIND = { unified: ['ok', 'Shielded'], sapling: ['ok', 'Sapling'], transparent: ['public', 'Public'], tex: ['public', 'TEX'] };

async function checkAddress(address) {
  const r = await api('/api/batch/validate', { text: `address,amount\n${csvCell(address)},1` });
  if (!r.ok) return { error: r.error.message };
  if (!r.result.ok) return { error: r.result.message };
  const row = r.result.rows[0];
  return row.errors.length ? { error: row.errors[0] } : { address: row.address, kind: row.kind };
}

export async function viewContacts(el) {
  await loadLists();
  const search = h('input', { type: 'search', placeholder: 'Search contacts', 'aria-label': 'Search contacts' });
  const list = h('div', { class: 'items' });
  el.append(h('div', { class: 'stack-lg' },
    h('div', { class: 'row nowrap' }, h('div', { class: 'spacer' }, search), btn('Add contact', 'sm', () => edit(), 'userPlus', { id: 'add-contact' })),
    h('section', { class: 'card' }, list)));
  search.addEventListener('input', () => draw());

  const save = async (contacts, msg) => { const r = await saveLists({ contacts }); toast(r.ok ? msg : 'Could not save', r.ok ? 'check' : 'alert'); draw(); };

  function edit(c) {
    modal(c ? 'Edit contact' : 'Add a contact', (close) => {
      const name = h('input', { type: 'text', id: 'c-name', maxlength: '60', value: c?.name ?? '', placeholder: 'Ada Lovelace' });
      const address = h('textarea', { id: 'c-addr', rows: 3, spellcheck: 'false', placeholder: 'u1…, zs1… or t1…' }); address.value = c?.address ?? '';
      const memo = h('input', { type: 'text', id: 'c-note', maxlength: '120', value: c?.note ?? '', placeholder: 'Optional, for you only' });
      const err = h('div');
      const ok = btn(c ? 'Save changes' : 'Save contact', 'block', async () => {
        err.replaceChildren();
        if (!name.value.trim()) return name.focus();
        ok.disabled = true;
        const v = await checkAddress(address.value.trim());
        ok.disabled = false;
        if (v.error) return err.append(errorNote({ message: v.error }));
        const others = S.lists.contacts.filter((x) => x.id !== c?.id);
        const dup = others.find((x) => x.address === v.address);
        if (dup) return err.append(errorNote({ message: `That address is already saved as ${dup.name}.` }));
        const next = { id: c?.id ?? crypto.randomUUID(), name: name.value.trim(), address: v.address, kind: v.kind, note: memo.value.trim(), updated: Date.now() };
        close();
        await save(c ? S.lists.contacts.map((x) => (x.id === c.id ? next : x)) : [...S.lists.contacts, next], c ? 'Contact updated' : 'Contact saved');
      }, null, { id: 'c-save' });
      queueMicrotask(() => name.focus());
      return h('div', { class: 'stack' },
        h('div', { class: 'field' }, h('label', { for: 'c-name' }, 'Name'), name),
        h('div', { class: 'field' }, h('label', { for: 'c-addr' }, 'Zcash address'), address, h('span', { class: 'hint' }, 'Checked against this wallet’s network before saving.')),
        h('div', { class: 'field' }, h('label', { for: 'c-note' }, 'Note'), memo), err, ok);
    });
  }

  function draw() {
    const q = search.value.trim().toLowerCase();
    const all = [...S.lists.contacts].sort((a, b) => a.name.localeCompare(b.name));
    const shown = all.filter((c) => !q || c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q) || (c.note ?? '').toLowerCase().includes(q));
    if (!all.length) return fill(list, emptyState('contacts', 'No contacts yet', 'Save the people you pay often. Then add them to a batch in one tap, from here or from Send.', btn('Add your first contact', 'sm', () => edit(), 'userPlus')));
    if (!shown.length) return fill(list, emptyState('search', 'No matches', `Nothing matches “${search.value}”.`));
    fill(list, ...shown.map((c) => {
      const [tone, label] = KIND[c.kind] ?? ['', 'Address'];
      return h('div', { class: 'item contact' },
        h('span', { class: 'avatar', vars: { '--h': hueOf(c.name) } }, monogram(c.name)),
        h('div', null, h('div', { class: 'title' }, c.name), h('div', { class: 'meta' }, h('span', { class: 'mono' }, short(c.address, 12)), h('span', { class: `pill ${tone}` }, label), c.note ? h('span', null, c.note) : null)),
        h('div', { class: 'row nowrap' },
          btn('Pay', 'xs', async () => { await appendRecipients([{ address: c.address, amount: '', label: c.name }]); S.sendFlow = { step: 'compose' }; nav.go('send'); toast(`${c.name} added. Enter the amount.`, 'send'); }, 'send'),
          iconBtn('edit', `Edit ${c.name}`, () => edit(c)),
          iconBtn('trash', `Delete ${c.name}`, async () => { if (await confirmDialog('Delete this contact?', `${c.name} will be removed from this computer.`, 'Delete', true)) save(S.lists.contacts.filter((x) => x.id !== c.id), 'Contact deleted'); })));
    }));
  }
  draw();
}
