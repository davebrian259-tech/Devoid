// Settings: appearance, connection, recovery phrase, passphrase, shielding, and what is running.
import { S, nav, api, h, btn, note, errorNote, unit, fill, confirmDialog, download, WEB, webEngine, webReset, isTest, poweredBy, unlock, UNLOCK_MINUTES } from '../lib.js';
import { icon } from '../icons.js';
import { fmtZec } from '../calc.js';
import { themeChoice, setTheme, onThemeChange } from '../theme.js';

const card = (title, sub, ...body) => h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, title), sub ? h('p', { class: 'small muted' }, sub) : null)), h('div', { class: 'stack' }, ...body));
const seg = (items, current, pick, label) => h('div', { class: 'seg', role: 'group', 'aria-label': label },
  items.map(([v, l, ic]) => h('button', { type: 'button', 'aria-pressed': String(current === v), onclick: () => pick(v) }, ic ? icon(ic) : null, l)));

export async function viewSettings(el) {
  const st = (await api('/api/settings')).result ?? { mode: 'direct', servers: 'zecrocks', socksProxy: '' };

  // appearance
  const themeBox = h('div');
  const drawTheme = () => {
    const cur = themeChoice() ?? 'system';
    fill(themeBox, seg([['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], cur, (v) => {
      setTheme(v === 'system' ? null : v); drawTheme();
    }, 'Theme'));
  };
  drawTheme();
  const offTheme = onThemeChange(() => { if (themeBox.isConnected) drawTheme(); else offTheme(); });

  // connection
  let mode = st.mode;
  const servers = h('input', { type: 'text', id: 'srv', value: st.servers, spellcheck: 'false' });
  const socks = h('input', { type: 'text', id: 'sx', value: st.socksProxy, placeholder: '127.0.0.1:9050' });
  const socksRow = h('div', { class: 'field', hidden: mode !== 'socks5' }, h('label', { for: 'sx' }, 'Proxy address'), socks);
  const connSeg = h('div');
  const drawConn = () => fill(connSeg, seg([['direct', 'Direct'], ['tor', 'Tor'], ['socks5', 'SOCKS5']], mode, (v) => { mode = v; socksRow.hidden = v !== 'socks5'; drawConn(); }, 'Connection'));
  drawConn();
  const connMsg = h('div');

  // recovery phrase
  const pw = h('input', { type: 'password', id: 'rp', autocomplete: 'current-password' }); const phraseOut = h('div');

  // passphrase
  const o1 = h('input', { type: 'password', id: 'o1', autocomplete: 'current-password' });
  const n1 = h('input', { type: 'password', id: 'n1', autocomplete: 'new-password' }); const cm = h('div');

  // shielding
  const shieldOut = h('div', { class: 'stack' });
  const shieldCard = card('Shield transparent funds', 'Move ZEC from your transparent address into the shielded pool, so it can be spent privately. The transfer itself is visible.', shieldOut,
    h('div', null, btn('Preview shielding', 'ghost sm', async () => {
      const r = await api('/api/engine/shield', { dryRun: true });
      if (!r.ok) return fill(shieldOut, r.error.code === 'nothing_to_shield' ? note('info', 'Nothing to shield', 'There is no transparent balance ready to shield.') : errorNote(r.error));
      const s = r.result; const p = h('input', { type: 'password', 'aria-label': 'Passphrase', placeholder: unlock.get() ? 'Unlocked' : 'Passphrase', disabled: Boolean(unlock.get()) }); const m = h('div');
      fill(shieldOut, note('warn', `Shield ${fmtZec(BigInt(s.inputs.transparent.valueZat))} ${unit()}`, `Fee ${fmtZec(s.feeZat, 4)} ${unit()}. ${s.privacy.findings[0]?.message ?? ''}`),
        h('div', { class: 'input-group' }, p, btn('Shield now', 'sm', async () => {
          const given = unlock.get() ?? p.value;
          const x = await api('/api/engine/shield', { passphrase: given, fingerprint: s.fingerprint, acknowledge: s.privacy.requiresAck }); p.value = '';
          if (!x.ok) { if (x.error?.code === 'wrong_passphrase') unlock.lock(); return fill(m, errorNote(x.error)); }
          unlock.keep(given);
          fill(shieldOut, note('ok', 'Shielding sent', 'It shows in Activity as pending until mined.')); nav.refresh(false);
        }, 'shielded')), m);
    }, 'shield')));
  shieldCard.id = 'shield';

  // Locked or unlocked: after a send, the passphrase stays in this page's memory for a while.
  const lockRow = h('div');
  const drawLock = () => fill(lockRow, unlock.get()
    ? h('div', { class: 'unlocked' }, h('span', { class: 'tile-ico received' }, icon('unlock')),
      h('div', null, h('b', null, 'Unlocked in this tab'), h('div', { class: 'small muted' }, `Sends and shielding will not ask for the passphrase. Locks after ${UNLOCK_MINUTES} minutes without activity.`)),
      btn('Lock now', 'xs ghost', () => unlock.lock(), 'lock'))
    : h('p', { class: 'small muted' }, `After you sign, you can stay unlocked in this tab for ${UNLOCK_MINUTES} minutes. The passphrase is kept in memory only, never stored.`));
  const onLock = () => (lockRow.isConnected ? drawLock() : document.removeEventListener('devoid-lock', onLock));
  drawLock(); document.addEventListener('devoid-lock', onLock);

  // Web wallet file: an encrypted copy to open this wallet in another browser or on another device.
  const fileCard = WEB && webEngine() === 'real' ? (() => {
    const kept = h('div'); const out = h('div');
    const pass = h('input', { type: 'password', id: 'wf-pw', autocomplete: 'current-password', placeholder: 'Passphrase' });
    api('/api/web/keep-storage').then((r) => fill(kept, r.ok && r.result.kept
      ? note('ok', 'This browser keeps your wallet', 'It will not clear it to free space. Clearing site data yourself still removes it.')
      : note('warn', 'This browser may clear your wallet', 'Some browsers drop a site’s data after a week without a visit. Keep a wallet file, and your recovery phrase on paper.')));
    const save = btn('Download wallet file', 'sm', async () => {
      out.replaceChildren();
      const given = pass.value || unlock.get();
      if (!given) return fill(out, errorNote({ message: 'Enter your passphrase to encrypt the file.' }));
      save.disabled = true;
      const r = await api('/api/web/wallet-file/export', { passphrase: given }); pass.value = '';
      save.disabled = false;
      if (!r.ok) return fill(out, errorNote(r.error));
      download(r.result.name, r.result.text, 'application/json');
      fill(out, note('ok', 'Wallet file saved.', 'Keep it somewhere safe. Anyone with the file and your passphrase can open this wallet.'));
    }, 'download', { id: 'wf-save' });
    return card('Wallet file', 'Open this wallet in any browser, on any device: download an encrypted copy, then choose “Open a wallet file” there. It opens only with your passphrase.',
      kept, h('div', { class: 'input-group' }, pass, save), out);
  })() : null;

  const status = S.status;
  el.append(h('div', { class: 'grid g-2' },
    h('div', { class: 'stack-lg' },
      card('Appearance', 'Follow your system, or pick one.', themeBox),
      WEB && webEngine() === 'real' ? card('Server', 'The web wallet reaches the Zcash network through a gRPC-web server, the kind a browser can use.',
        h('dl', { class: 'kv small' }, h('dt', null, 'Server'), h('dd', { class: 'mono' }, isTest() ? 'zcash-testnet.chainsafe.dev' : 'zcash-mainnet.chainsafe.dev'), h('dt', null, 'Run by'), h('dd', null, 'ChainSafe, in front of lightwalletd')),
        note('info', 'What the server sees', 'Your IP address, and the transactions you broadcast. Shielded transactions hide recipients, amounts and memos from it. Tor is not available in a browser; use the desktop app to hide your IP address.')) : null,
      WEB ? card(webEngine() === 'real' ? 'This browser’s wallet' : 'Web demo', webEngine() === 'real'
        ? 'Your wallet is stored in this browser, its keys encrypted with your passphrase. Clearing site data removes it.'
        : 'This wallet, its lists and contacts are kept in this browser only. Clearing site data removes them.',
        h('div', null, btn(webEngine() === 'real' ? 'Delete this wallet' : 'Reset the demo', 'danger sm', async () => {
          const real = webEngine() === 'real';
          const ok = real
            ? await confirmDialog('Delete this wallet from this browser?', 'Only your recovery phrase can bring it back, in the desktop app. Make sure you have it written down before you continue.', 'Delete wallet', true)
            : await confirmDialog('Reset the demo?', 'This deletes the demo wallet, its lists and contacts from this browser. You can create a new one afterwards.', 'Reset', true);
          if (!ok) return;
          await webReset();
          location.replace(location.pathname);
        }, 'trash'))) : null,
      fileCard,
      WEB ? null : card('Network connection', 'Devoid asks a lightwalletd server for blocks. Tor hides your IP address from that server.', connSeg,
        h('div', { class: 'field' }, h('label', { for: 'srv' }, 'Servers'), servers, h('span', { class: 'hint' }, 'A preset (zecrocks, ywallet) or host:port, comma separated.')), socksRow, connMsg,
        h('div', null, btn('Save connection', 'sm', async () => {
          const r = await api('/api/settings', { mode, servers: servers.value.trim() || 'zecrocks', socksProxy: socks.value.trim() });
          fill(connMsg, r.ok ? note('ok', 'Saved.') : errorNote(r.error));
        }))),
      card('About', null,
        h('dl', { class: 'kv small' },
          h('dt', null, 'Engine'), h('dd', null, WEB ? (webEngine() === 'real' ? 'devoid-engine, compiled to WebAssembly, running in this browser' : 'Simulated demo engine, running in this browser') : status.simulated ? 'Simulated demo engine' : `devoid-engine, self-test ${status.engineVerified ? 'passed' : 'not run'}`),
          h('dt', null, 'Network'), h('dd', null, status.wallet.network === 'test' ? 'Zcash testnet' : 'Zcash mainnet'),
          h('dt', null, 'Built on'), h('dd', null, 'librustzcash (zcash_client_backend, zcash_client_sqlite, Orchard and Sapling), from the Electric Coin Company and the Zcash Foundation'),
          h('dt', null, 'Standards'), h('dd', null, 'ZIP 316 unified addresses, ZIP 317 fees, ZIP 321 payment requests'),
          status.wallet.birthday ? [h('dt', null, 'Wallet birthday'), h('dd', { class: 'num' }, `Block ${status.wallet.birthday.toLocaleString()}`)] : null,
          h('dt', null, 'Type'), h('dd', null, 'Righteous, Outfit, JetBrains Mono (SIL OFL)'),
          h('dt', null, 'Icons'), h('dd', null, 'Lucide (ISC)')),
        poweredBy())),
    h('div', { class: 'stack-lg' },
      card('Recovery phrase', 'Show the 24 words that restore this wallet. Make sure nobody can see your screen.',
        h('div', { class: 'field' }, h('label', { for: 'rp' }, 'Passphrase'), h('div', { class: 'input-group' }, pw, btn('Show', 'sm ghost', async () => {
          const r = await api('/api/engine/revealPhrase', { passphrase: pw.value }); pw.value = '';
          if (!r.ok) return fill(phraseOut, errorNote(r.error));
          fill(phraseOut, h('div', { class: 'stack' }, h('div', { class: 'phrase' }, r.result.phrase.split(' ').map((w) => h('span', null, w))), h('div', null, btn('Hide', 'ghost sm', () => phraseOut.replaceChildren(), 'eyeOff'))));
        }, 'key'))), phraseOut),
      card('Passphrase', WEB && webEngine() !== 'real' ? 'Change the passphrase this demo asks for before each send.' : WEB ? 'Change the passphrase that encrypts your keys in this browser.' : 'Change the passphrase that encrypts your keys on this computer.',
        lockRow,
        h('div', { class: 'field' }, h('label', { for: 'o1' }, 'Current passphrase'), o1),
        h('div', { class: 'field' }, h('label', { for: 'n1' }, 'New passphrase'), n1), cm,
        h('div', null, btn('Change passphrase', 'ghost sm', async () => {
          const r = await api('/api/engine/changePassphrase', { passphrase: o1.value, newPassphrase: n1.value }); o1.value = n1.value = '';
          if (r.ok) unlock.lock(); // the old one no longer signs
          fill(cm, r.ok ? note('ok', 'Passphrase changed.', WEB && webEngine() === 'real' ? 'Wallet files you saved before still open with the old passphrase. Download a new one.' : null) : errorNote(r.error));
        }, 'lock'))),
      shieldCard)));

  if (S.focusShield) { S.focusShield = false; shieldCard.scrollIntoView({ behavior: 'smooth', block: 'center' }); shieldCard.classList.add('flash'); }
}
