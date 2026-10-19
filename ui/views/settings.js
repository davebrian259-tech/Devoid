// Settings: appearance, connection, recovery phrase, passphrase, shielding, and what is running.
import { S, nav, api, h, btn, note, errorNote, unit, fill, confirmDialog, WEB, webEngine, webReset, isTest } from '../lib.js';
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
      const s = r.result; const p = h('input', { type: 'password', 'aria-label': 'Passphrase', placeholder: 'Passphrase' }); const m = h('div');
      fill(shieldOut, note('warn', `Shield ${fmtZec(BigInt(s.inputs.transparent.valueZat))} ${unit()}`, `Fee ${fmtZec(s.feeZat, 4)} ${unit()}. ${s.privacy.findings[0]?.message ?? ''}`),
        h('div', { class: 'input-group' }, p, btn('Shield now', 'sm', async () => {
          const x = await api('/api/engine/shield', { passphrase: p.value, fingerprint: s.fingerprint, acknowledge: s.privacy.requiresAck }); p.value = '';
          if (!x.ok) return fill(m, errorNote(x.error));
          fill(shieldOut, note('ok', 'Shielding sent', 'It shows in Activity as pending until mined.')); nav.refresh(false);
        }, 'shielded')), m);
    }, 'shield')));
  shieldCard.id = 'shield';

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
      WEB ? null : card('Network connection', 'Devoid asks a lightwalletd server for blocks. Tor hides your IP address from that server.', connSeg,
        h('div', { class: 'field' }, h('label', { for: 'srv' }, 'Servers'), servers, h('span', { class: 'hint' }, 'A preset (zecrocks, ywallet) or host:port, comma separated.')), socksRow, connMsg,
        h('div', null, btn('Save connection', 'sm', async () => {
          const r = await api('/api/settings', { mode, servers: servers.value.trim() || 'zecrocks', socksProxy: socks.value.trim() });
          fill(connMsg, r.ok ? note('ok', 'Saved.') : errorNote(r.error));
        }))),
      card('About', null,
        h('dl', { class: 'kv small' },
          h('dt', null, 'Engine'), h('dd', null, WEB ? (webEngine() === 'real' ? 'devoid-engine, compiled to WebAssembly, running in this browser' : 'Simulated demo engine, running in this browser') : status.simulated ? 'Simulated demo engine' : `devoid-engine, self-test ${status.engineVerified ? 'passed' : 'not run'}`),
          h('dt', null, 'Network'), h('dd', null, status.wallet.network === 'test' ? 'Testnet' : 'Mainnet'),
          status.wallet.birthday ? [h('dt', null, 'Wallet birthday'), h('dd', { class: 'num' }, `Block ${status.wallet.birthday.toLocaleString()}`)] : null,
          h('dt', null, 'Type'), h('dd', null, 'Righteous, Outfit, JetBrains Mono (SIL OFL)'),
          h('dt', null, 'Icons'), h('dd', null, 'Lucide (ISC)')))),
    h('div', { class: 'stack-lg' },
      card('Recovery phrase', 'Show the 24 words that restore this wallet. Make sure nobody can see your screen.',
        h('div', { class: 'field' }, h('label', { for: 'rp' }, 'Passphrase'), h('div', { class: 'input-group' }, pw, btn('Show', 'sm ghost', async () => {
          const r = await api('/api/engine/revealPhrase', { passphrase: pw.value }); pw.value = '';
          if (!r.ok) return fill(phraseOut, errorNote(r.error));
          fill(phraseOut, h('div', { class: 'stack' }, h('div', { class: 'phrase' }, r.result.phrase.split(' ').map((w) => h('span', null, w))), h('div', null, btn('Hide', 'ghost sm', () => phraseOut.replaceChildren(), 'eyeOff'))));
        }, 'key'))), phraseOut),
      card('Passphrase', WEB && webEngine() !== 'real' ? 'Change the passphrase this demo asks for before each send.' : WEB ? 'Change the passphrase that encrypts your keys in this browser.' : 'Change the passphrase that encrypts your keys on this computer.',
        h('div', { class: 'field' }, h('label', { for: 'o1' }, 'Current passphrase'), o1),
        h('div', { class: 'field' }, h('label', { for: 'n1' }, 'New passphrase'), n1), cm,
        h('div', null, btn('Change passphrase', 'ghost sm', async () => {
          const r = await api('/api/engine/changePassphrase', { passphrase: o1.value, newPassphrase: n1.value }); o1.value = n1.value = '';
          fill(cm, r.ok ? note('ok', 'Passphrase changed.') : errorNote(r.error));
        }, 'lock'))),
      shieldCard)));

  if (S.focusShield) { S.focusShield = false; shieldCard.scrollIntoView({ behavior: 'smooth', block: 'center' }); shieldCard.classList.add('flash'); }
}
