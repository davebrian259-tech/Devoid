// First run: what Devoid is, then create or restore a wallet, then prove the phrase was written down.
import { h, btn, api, errorNote, note, fill, WEB } from '../lib.js';
import { icon, mark } from '../icons.js';
import { themeButton } from '../theme.js';

const NS = 'http://www.w3.org/2000/svg';

function flowArt() {
  const rows = [['u1qz…7hk2', '0.25'], ['zs1x…m9wf', '1.10'], ['u1r8…c4p0', '0.40'], ['u1lm…z2e6', '0.75']];
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 64 150'); svg.setAttribute('class', 'lines'); svg.setAttribute('aria-hidden', 'true');
  for (const y of [18, 55, 92, 129]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', `M0 ${y} C 36 ${y}, 30 75, 64 75`); svg.append(p); }
  return h('div', { class: 'flow', 'aria-hidden': 'true' },
    h('div', { class: 'rows' }, rows.map(([a, v]) => h('i', null, a, h('b', null, v)))),
    svg,
    h('div', { class: 'one' }, h('div', { class: 'row' }, icon('shielded'), h('span', { class: 'small' }, '1 shielded transaction')),
      h('b', null, '4 recipients'), h('div', { class: 'redline' }), h('div', { class: 'redline w2' })));
}

function hero() {
  return h('section', { class: 'hero' },
    h('div', { class: 'brand' }, mark(), h('span', { class: 'wordmark' }, 'devoid')),
    h('div', { class: 'stack-lg' },
      h('h1', null, 'Pay everyone at once. ', h('em', null, 'Privately.')),
      h('p', { class: 'lede' }, 'Devoid sends Zcash to a whole list of people in one shielded transaction: payroll, grants, DAO payouts. Recipients, amounts and memos stay hidden on chain.')),
    flowArt(),
    h('div', { class: 'points' },
      h('div', null, h('span', { class: 'tile-ico' }, icon('lock')), h('span', null, h('b', null, 'Your keys stay here'), WEB ? 'The wallet runs in your browser, keys encrypted with your passphrase. There is no Devoid server.' : 'Encrypted on this computer. Devoid never asks for your phrase after setup.')),
      h('div', null, h('span', { class: 'tile-ico' }, icon('eye')), h('span', null, h('b', null, 'See what is visible first'), 'Before you sign, Devoid shows exactly what the chain will reveal.')),
      h('div', null, h('span', { class: 'tile-ico' }, icon('layers')), h('span', null, h('b', null, 'Up to 2,000 recipients'), 'Large lists go out as a few transactions of 25, in order.'))));
}

function strengthOf(p) {
  if (p.length < 8) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((r) => r.test(p)).length + (/\s/.test(p) ? 1 : 0);
  if (p.length >= 16 || (p.length >= 12 && kinds >= 3)) return 3;
  return p.length >= 10 || kinds >= 3 ? 2 : 1;
}

export function renderWelcome(root, onDone) {
  // The web version never takes a recovery phrase, and its demo is testnet only: see local/backend.js.
  let mode = 'create'; let network = WEB ? 'test' : 'main';
  let engine = 'real';
  const demo = () => WEB && engine === 'demo';
  const side = h('section', { class: 'panel-side' });
  fill(root, h('div', { class: 'welcome' }, hero(), side, themeButton('icon-btn welcome-theme')));

  const seg = (items, current, pick, label) => h('div', { class: 'seg block', role: 'group', 'aria-label': label },
    items.map(([v, l, ic]) => h('button', { type: 'button', 'aria-pressed': String(current === v), onclick: () => pick(v) }, ic ? icon(ic) : null, l)));

  function form() {
    const err = h('div');
    const pass = h('input', { type: 'password', autocomplete: 'new-password', id: 'p1', placeholder: 'At least 8 characters' });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password', id: 'p2' });
    const words = h('textarea', { id: 'ph', rows: 3, placeholder: 'word1 word2 word3 …', spellcheck: 'false', autocomplete: 'off' });
    const meter = h('div', { class: 'strength' }, h('i'));
    const meterText = h('span', { class: 'hint' }, demo() ? 'Asked before each send, as in the real app. Make one up; do not reuse a real password.' : WEB ? 'Encrypts your keys in this browser. Make it long: it is what protects them.' : 'Encrypts your keys on this computer.');
    pass.addEventListener('input', () => {
      const s = strengthOf(pass.value);
      meter.className = `strength s${s}`; meter.firstChild.style.width = `${[6, 34, 67, 100][s]}%`;
      meterText.textContent = ['Too short: use at least 8 characters.', 'Weak. Longer is stronger; a few random words work well.', 'Good.', 'Strong.'][s];
    });
    // Web mainnet: real ZEC held in a browser deserves one deliberate tick before the wallet exists.
    const mainnetAck = h('input', { type: 'checkbox', id: 'mainnet-ack' });
    const go = btn(mode === 'create' ? 'Create wallet' : 'Restore wallet', 'lg block', async () => {
      // Web version: the engine is chosen with the wallet.
      if (WEB) {
        const e = await api('/api/web/engine', { engine });
        if (!e.ok) return fill(err, errorNote(e.error));
      }
      err.replaceChildren();
      if (pass.value.length < 8) return err.append(errorNote({ message: 'Use a passphrase of at least 8 characters.' }));
      if (pass.value !== pass2.value) return err.append(errorNote({ message: 'The two passphrases are different.' }));
      if (WEB && !demo() && network === 'main' && !mainnetAck.checked) return err.append(errorNote({ message: 'Tick the box to confirm that this wallet will hold real ZEC in this browser.' }));
      go.disabled = true; go.lastChild.textContent = WEB && !demo() ? 'Starting the wallet engine…' : mode === 'create' ? 'Creating…' : 'Restoring…';
      const r = await api('/api/engine/create', { passphrase: pass.value, network, phrase: mode === 'restore' ? words.value : undefined });
      go.disabled = false; go.lastChild.textContent = mode === 'create' ? 'Create wallet' : 'Restore wallet';
      if (!r.ok) return err.append(errorNote(r.error));
      pass.value = pass2.value = '';
      if (r.result.phrase) showPhrase(r.result.phrase); else onDone();
    }, 'arrowRight');
    fill(side, h('div', { class: 'form-card stack-lg' },
      h('div', null, h('h2', null, demo() ? 'Create a demo wallet' : WEB ? (network === 'main' ? 'Create a mainnet wallet' : 'Create a testnet wallet') : mode === 'create' ? 'Create your wallet' : 'Restore a wallet'),
        h('p', { class: 'sub' }, demo() ? 'Test coins on a simulated chain, so you can try every screen. It lives in this browser only.' : WEB ? `A real Zcash wallet that runs in this browser, on ${network === 'main' ? 'mainnet' : 'the test network'}. You will get 24 words that can restore it.` : mode === 'create' ? 'It takes a minute. You will get 24 words that can restore it anywhere.' : 'Enter your 24-word recovery phrase. Devoid then scans the chain for your funds.')),
      WEB ? seg([['real', 'Real wallet', 'shield'], ['demo', 'Demo', 'info']], engine, (v) => { engine = v; form(); }, 'Wallet kind') : null,
      WEB ? (demo()
        ? note('test', 'Demo: play money', 'Payments are simulated on a made-up chain and have no value. Nothing touches a real network.')
        : network === 'main'
          ? note('warn', 'Mainnet: real ZEC', 'Keys stay in this browser, encrypted with your passphrase. Start with small amounts, and keep your recovery phrase on paper: if this browser’s data is cleared, it is the only way back, in the desktop app.')
          : note('test', 'Real wallet, test network', 'Real transactions on the Zcash testnet, with free coins from a faucet. Keys stay in this browser, encrypted with your passphrase.'))
        : seg([['create', 'New wallet', 'plus'], ['restore', 'Restore', 'refresh']], mode, (v) => { mode = v; form(); }, 'Wallet setup'),
      mode === 'restore' ? h('div', { class: 'field' }, h('label', { for: 'ph' }, 'Recovery phrase'), words) : null,
      demo() ? null : h('div', { class: 'field' }, h('span', { class: 'label' }, 'Network'),
        seg([['main', 'Mainnet', 'globe'], ['test', 'Testnet', 'info']], network, (v) => { network = v; form(); }, 'Network'),
        h('span', { class: 'hint' }, network === 'main' ? 'Real ZEC. Use small amounts until you know the flow.' : 'Play money (TAZ) from a faucet. Nothing here has value.')),
      h('div', { class: 'field' }, h('label', { for: 'p1' }, 'Passphrase'), pass, meter, meterText),
      h('div', { class: 'field' }, h('label', { for: 'p2' }, 'Repeat passphrase'), pass2),
      WEB && !demo() && network === 'main' ? h('label', { class: 'check', for: 'mainnet-ack' }, mainnetAck, 'I understand this wallet holds real ZEC, in this browser.') : null,
      err, go,
      h('p', { class: 'hint' }, demo() ? 'Forgot it later? Reset the demo in Settings and start again.' : WEB ? 'The web version never asks for a recovery phrase. To restore a wallet, or if you forget the passphrase, use your recovery phrase in the desktop app.' : 'If you forget the passphrase, only the recovery phrase can bring your funds back.')));
  }

  function showPhrase(phrase) {
    const ok = h('input', { type: 'checkbox', id: 'wrote' });
    const next = btn('Continue', 'lg block', () => verify(phrase), 'arrowRight'); next.disabled = true;
    ok.addEventListener('change', () => { next.disabled = !ok.checked; });
    fill(side, h('div', { class: 'form-card stack-lg' },
      h('div', null, h('h2', null, 'Write down your recovery phrase'),
        h('p', { class: 'sub' }, 'These 24 words are your wallet. Anyone with them can take your funds, and nobody can recover them for you. Write them on paper, in order.')),
      h('div', { class: 'phrase' }, phrase.split(' ').map((w) => h('span', null, w))),
      demo() ? note('info', 'These are demo words.', 'They show how a real backup works, but they cannot restore a real wallet. Never type a real recovery phrase into any website.')
        : WEB ? note('warn', 'Write these words on paper now.', 'They are the only way back to this wallet if this browser’s data is cleared. Devoid on the web will never ask for them; restore in the desktop app.')
        : note('warn', 'Never type these words into a website or share a photo of them.', 'Devoid will not ask for them again unless you restore.'),
      h('label', { class: 'check', for: 'wrote' }, ok, 'I wrote the phrase down and stored it somewhere safe.'), next));
  }

  // Asks for three random words, so a skipped backup is caught now rather than when it is needed.
  function verify(phrase) {
    const list = phrase.split(' ');
    const picks = [];
    while (picks.length < 3) { const i = Math.floor(Math.random() * list.length); if (!picks.includes(i)) picks.push(i); }
    picks.sort((a, b) => a - b);
    const err = h('div');
    const inputs = picks.map((i) => h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'data-word': String(i + 1), id: `w${i + 1}`, autocapitalize: 'off' }));
    const done = btn('Open my wallet', 'lg block', () => {
      err.replaceChildren();
      const wrong = picks.filter((i, k) => inputs[k].value.trim().toLowerCase() !== list[i]);
      if (wrong.length) return err.append(errorNote({ message: `Word ${wrong.map((i) => i + 1).join(', ')} does not match. Check your paper copy.` }));
      onDone();
    }, 'arrowRight');
    fill(side, h('div', { class: 'form-card stack-lg' },
      h('div', null, h('h2', null, 'Check your backup'), h('p', { class: 'sub' }, 'Type these words from your paper copy.')),
      h('div', { class: 'stack' }, picks.map((i, k) => h('div', { class: 'field' }, h('label', { for: `w${i + 1}` }, `Word #${i + 1}`), inputs[k]))),
      err, done, btn('Show the phrase again', 'ghost block', () => showPhrase(phrase), 'arrowLeft')));
    inputs[0].focus();
  }

  form();
}

export function renderGate(root, title, body) {
  fill(root, h('div', { class: 'welcome' }, themeButton('icon-btn welcome-theme'), hero(), h('section', { class: 'panel-side' }, h('div', { class: 'form-card stack' }, h('h2', null, title), body))));
}
