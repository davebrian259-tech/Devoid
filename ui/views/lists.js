// Lists: saved recipient lists for recurring payments. Use, rename, duplicate, export, delete.
import { S, nav, api, h, btn, modal, confirmDialog, download, toast, unit, emptyState, saveLists, loadLists, fill } from '../lib.js';
import { icon } from '../icons.js';
import { fmtZec } from '../calc.js';

function nameDialog(title, value, action, onSave) {
  modal(title, (close) => {
    const name = h('input', { type: 'text', value, maxlength: '80', 'aria-label': 'List name' });
    const save = btn(action, 'block', async () => { if (!name.value.trim()) return name.focus(); close(); await onSave(name.value.trim()); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
    queueMicrotask(() => { name.focus(); name.select(); });
    return h('div', { class: 'stack' }, name, save);
  });
}

export async function viewLists(el) {
  await loadLists();
  const grid = h('div', { class: 'grid g-3' });
  el.append(h('div', { class: 'stack-lg' },
    h('div', { class: 'row between' }, h('span', { class: 'muted small', id: 'list-count' }), btn('New list', 'sm', () => editor(), 'plus')), grid));

  const save = async (lists, msg) => { const r = await saveLists({ lists }); if (msg) toast(r.ok ? msg : 'Could not save', r.ok ? 'check' : 'alert'); draw(); };

  function editor() {
    modal('New list', (close) => {
      const name = h('input', { type: 'text', maxlength: '80', placeholder: 'For example: Monthly grants', 'aria-label': 'List name' });
      const text = h('textarea', { spellcheck: 'false', placeholder: 'address,amount,memo\nu1…,0.25,Grant\n', 'aria-label': 'Recipients' });
      const ok = btn('Save list', 'block', async () => {
        if (!name.value.trim()) return name.focus();
        if (!text.value.trim()) return text.focus();
        close(); await save([...S.lists.lists, { id: crypto.randomUUID(), name: name.value.trim(), text: text.value, updated: Date.now() }], 'List saved');
      });
      queueMicrotask(() => name.focus());
      return h('div', { class: 'stack' }, h('div', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name), h('div', { class: 'field' }, h('span', { class: 'label' }, 'Recipients'), text, h('span', { class: 'hint' }, 'Same format as the Send page. Devoid checks it when you use the list.')), ok);
    });
  }

  function draw() {
    const lists = [...S.lists.lists].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    document.getElementById('list-count')?.replaceChildren(lists.length ? `${lists.length} saved list${lists.length === 1 ? '' : 's'}` : '');
    if (!lists.length) {
      fill(grid, h('section', { class: 'card', vars: {} }, emptyState('lists', 'No saved lists yet', 'Save a batch from the Send page, or create one here. Lists are perfect for payroll, grants and DAO payouts.', btn('Create a list', 'sm', () => editor(), 'plus'))));
      grid.firstChild.classList.add('span-all');
      return;
    }
    fill(grid, ...lists.map((l) => {
      const count = h('b', null, '…'); const total = h('b', { class: 'num' }, '…');
      const card = h('section', { class: 'card tpl' },
        h('div', { class: 'top-row' }, h('div', { class: 'row nowrap' }, h('span', { class: 'tile-ico' }, icon('lists')), h('div', null, h('h3', null, l.name), h('div', { class: 'tiny faint' }, `Updated ${new Date(l.updated).toLocaleDateString()}`))),
          h('div', { class: 'row nowrap' },
            btn('', 'xs ghost icon-only', () => nameDialog('Rename list', l.name, 'Rename', (n) => save(S.lists.lists.map((x) => (x.id === l.id ? { ...x, name: n, updated: Date.now() } : x)), 'Renamed')), 'edit', { 'aria-label': `Rename ${l.name}`, title: 'Rename' }),
            btn('', 'xs ghost icon-only', async () => { if (await confirmDialog('Delete this list?', `“${l.name}” will be removed from this computer. Payments already sent are not affected.`, 'Delete', true)) save(S.lists.lists.filter((x) => x.id !== l.id), 'List deleted'); }, 'trash', { 'aria-label': `Delete ${l.name}`, title: 'Delete' }))),
        h('div', { class: 'stats' }, h('div', null, count, h('span', null, 'recipients')), h('div', null, total, h('span', null, unit()))),
        h('div', { class: 'actions' },
          btn('Use', 'xs', () => { S.draft.text = l.text; S.sendFlow = { step: 'compose' }; nav.go('send'); }, 'send'),
          btn('Duplicate', 'xs ghost', () => save([...S.lists.lists, { ...l, id: crypto.randomUUID(), name: `${l.name} (copy)`.slice(0, 80), updated: Date.now() }], 'Duplicated'), 'duplicate'),
          btn('Export', 'xs ghost', () => download(`${l.name.replace(/[^\w.-]+/g, '-')}.csv`, l.text.endsWith('\n') ? l.text : `${l.text}\n`), 'download')));
      api('/api/batch/validate', { text: l.text }).then((v) => {
        if (v.ok && v.result.ok) { count.textContent = v.result.valid + (v.result.invalid ? ` (+${v.result.invalid})` : ''); total.textContent = fmtZec(v.result.totalZat); }
        else { count.textContent = '—'; total.textContent = '—'; }
      });
      return card;
    }));
  }
  draw();
}
