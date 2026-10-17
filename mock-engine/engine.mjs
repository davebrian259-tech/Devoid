#!/usr/bin/env node
// Simulated Devoid engine. Speaks exactly the protocol of the Rust engine (one JSON request on
// stdin, NDJSON on stdout, last line is the result) but runs against a small simulated chain kept
// in <wallet>/mock.json. It exists so the server and the UI can be run, tested and demoed without
// a Zcash node. Nothing here is real money, real cryptography or a real network.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parseAddress, encodeUnified, destinationPool } from '../server/batch/address.mjs';
import { base58CheckEncode } from '../server/batch/base58.mjs';
import { bech32Encode, convertBits, BECH32 } from '../server/batch/bech32.mjs';

export const SIMULATED = true;
const MAX_RECIPIENTS = 30;
const GENESIS_HEIGHT = 3_500_000;
const BLOCK_MS = 6_000; // simulated blocks are fast so a demo shows confirmations
const WORDS = 'able acid aim album alert alpha amber angle apple arch arrow atom aunt award azure badge basic beam bench berry bison blend bloom bonus brave brick brisk cabin cable camel candy cargo cedar chalk charm chess cider civic claim cliff cloud coast comet coral crane crisp daisy dance delta denim dream drift eagle earth ember epoch fable fancy fern field flame flint focus forest frost gamma ginger glide grain grove habit harbor hazel heron honey humble icon igloo index iris ivory jade jelly jolly karma kite lace lemon lunar maple marsh meadow mist nova oasis olive orbit otter pearl pilot plume quartz quest quill raven reef river sable scout shore silk solar spark spruce stone tidal topaz unity vapor velvet violet willow yarn zephyr zinc'.split(' ');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const progress = (stage, f = {}) => out({ event: 'progress', stage, ...f });
class Fail extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details ?? null; }
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
const now = () => Date.now();
const heightAt = (t, st) => GENESIS_HEIGHT + Math.floor((t - st.chainStart) / BLOCK_MS);

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ---- storage -------------------------------------------------------------------------------
const file = (req) => join(String(req.wallet ?? ''), 'mock.json');
function need(req) {
  if (!req.wallet) throw new Fail('bad_request', 'The request is missing "wallet".');
}
function load(req) {
  need(req);
  if (!existsSync(file(req))) throw new Fail('no_wallet', 'There is no wallet in this folder yet.');
  return JSON.parse(readFileSync(file(req), 'utf8'));
}
function save(req, st) {
  const tmp = `${file(req)}.tmp`;
  writeFileSync(tmp, JSON.stringify(st, null, 1), { mode: 0o600 });
  renameSync(tmp, file(req));
}
function checkPass(st, pass) {
  if (!pass || sha(st.salt + pass) !== st.passHash) throw new Fail('wrong_passphrase', 'That passphrase is not correct.');
}

// ---- addresses -----------------------------------------------------------------------------
function makeAddresses(network) {
  const r = (n) => Uint8Array.from(randomBytes(n));
  const ua = encodeUnified(network, [{ typecode: 2, data: r(43) }, { typecode: 3, data: r(43) }]);
  const sapling = bech32Encode(network === 'main' ? 'zs' : 'ztestsapling', convertBits(r(43), 8, 5, true), BECH32);
  const prefix = network === 'main' ? [0x1c, 0xb8] : [0x1d, 0x25];
  const t = base58CheckEncode(Uint8Array.from([...prefix, ...r(20)]));
  return { shielded: ua, sapling, transparent: t };
}
const freshUA = (network) => encodeUnified(network, [{ typecode: 2, data: Uint8Array.from(randomBytes(43)) }, { typecode: 3, data: Uint8Array.from(randomBytes(43)) }]);

// ---- chain simulation ----------------------------------------------------------------------
function settle(st) {
  const h = heightAt(now(), st);
  for (const tx of st.txs) {
    if (tx.minedHeight == null && h >= tx.createdHeight + 2) {
      tx.minedHeight = tx.createdHeight + 2;
      tx.blockTime = Math.floor(now() / 1000);
    }
  }
  return h;
}
function balances(st, h) {
  const out = { ironwood: { spendable: 0, pending: 0 }, sapling: { spendable: 0, pending: 0 }, transparent: { spendable: 0, pending: 0 } };
  for (const n of st.notes) {
    if (n.spentBy) continue;
    const confirmed = n.minedHeight != null && h - n.minedHeight + 1 >= (n.pool === 'transparent' ? 1 : 3);
    out[n.pool][confirmed ? 'spendable' : 'pending'] += n.value;
  }
  return out;
}
const spendable = (st, h) => st.notes.filter((n) => !n.spentBy && n.minedHeight != null && h - n.minedHeight + 1 >= (n.pool === 'transparent' ? 1 : 3));

// ---- commands ------------------------------------------------------------------------------
const commands = {
  version: () => ({
    engine: 'devoid-engine (simulated)', simulated: true, version: '0.1.0-sim', protocol: 1,
    networks: ['main', 'test'], maxRecipientsPerTx: MAX_RECIPIENTS, maxTxBytes: 100000,
    commands: Object.keys(commands),
  }),

  selftest: () => ({ engine: 'simulated', passed: 1, failed: 0, checks: [{ name: 'simulated-engine', ok: true, detail: 'The simulated engine runs. It does not touch a real network.' }] }),

  info: (req) => {
    need(req);
    if (!existsSync(file(req))) return { exists: false };
    const st = load(req);
    const h = settle(st);
    return { exists: true, simulated: true, network: st.network, birthday: st.birthday, createdAt: st.createdAt, accountId: st.accountId, chainHeight: h, ironwoodActivationHeight: 3_428_143, ironwoodActive: true };
  },

  create: (req) => {
    need(req);
    if (existsSync(file(req))) throw new Fail('wallet_exists', 'A wallet already exists in this folder.');
    const pass = String(req.passphrase ?? '');
    if (pass.length < 8) throw new Fail('weak_passphrase', 'Use a passphrase of at least 8 characters.');
    const network = req.network === 'test' ? 'test' : 'main';
    const restoring = typeof req.phrase === 'string' && req.phrase.trim() !== '';
    const words = restoring ? req.phrase.trim().toLowerCase().split(/\s+/) : Array.from({ length: 24 }, () => WORDS[randomBytes(1)[0] % WORDS.length]);
    if (restoring && ![12, 15, 18, 21, 24].includes(words.length)) throw new Fail('bad_phrase', 'That recovery phrase is not valid. Check the words and their order.');
    mkdirSync(req.wallet, { recursive: true });
    const salt = randomBytes(8).toString('hex');
    const t0 = now();
    const addrs = makeAddresses(network);
    const st = {
      network, birthday: GENESIS_HEIGHT, createdAt: Math.floor(t0 / 1000), chainStart: t0 - 40 * BLOCK_MS,
      salt, passHash: sha(salt + pass), phrase: words.join(' '), accountId: randomBytes(16).toString('hex'),
      addresses: addrs, extra: [], notes: [], txs: [], simulated: true,
    };
    if (!restoring) {
      // Simulated faucet so the demo has something to spend.
      const h = heightAt(t0, st) - 30;
      st.notes.push({ id: randomBytes(4).toString('hex'), pool: 'ironwood', value: 1_250_000_000, minedHeight: h });
      st.notes.push({ id: randomBytes(4).toString('hex'), pool: 'sapling', value: 300_000_000, minedHeight: h });
      st.notes.push({ id: randomBytes(4).toString('hex'), pool: 'transparent', value: 40_000_000, minedHeight: h });
      const txid = randomBytes(32).toString('hex');
      st.txs.push({ txid, kind: 'received', createdHeight: h, minedHeight: h, blockTime: Math.floor(t0 / 1000) - 3000, expiryHeight: 0, delta: 1_590_000_000, fee: null, spent: 0, received: 1_590_000_000, outputs: [{ pool: 'ironwood', index: 0, address: addrs.shielded, valueZat: 1_250_000_000, isChange: false, toSelf: true, memo: 'Simulated faucet', memoKind: 'text' }], poolCrossing: null });
    }
    save(req, st);
    const result = { network, birthday: st.birthday, accountId: st.accountId, addresses: addrs, restored: restoring, simulated: true };
    if (!restoring) result.phrase = st.phrase;
    return result;
  },

  balance: (req) => {
    const st = load(req);
    const h = settle(st);
    const b = balances(st, h);
    const tot = (k) => b[k].spendable + b[k].pending;
    const pool = (k) => ({ spendable: b[k].spendable, pendingChange: 0, pendingReceived: b[k].pending, locked: 0, uneconomic: 0, total: tot(k) });
    const spend = b.ironwood.spendable + b.sapling.spendable + b.transparent.spendable;
    const total = tot('ironwood') + tot('sapling') + tot('transparent');
    save(req, st);
    return {
      ready: true, simulated: true, chainHeight: h, fullyScannedHeight: h, scanFraction: 1, ironwoodActive: true,
      total, spendable: spend, pendingChange: 0, pendingReceived: total - spend,
      pools: { ironwood: pool('ironwood'), orchard: { spendable: 0, pendingChange: 0, pendingReceived: 0, locked: 0, uneconomic: 0, total: 0 }, sapling: pool('sapling'), transparent: pool('transparent') },
    };
  },

  addresses: (req) => load(req).addresses,
  newAddress: (req) => { const st = load(req); const a = freshUA(st.network); st.extra.push(a); save(req, st); return { shielded: a }; },
  revealPhrase: (req) => { const st = load(req); checkPass(st, req.passphrase); return { phrase: st.phrase }; },
  changePassphrase: (req) => {
    const st = load(req); checkPass(st, req.passphrase);
    if (String(req.newPassphrase ?? '').length < 8) throw new Fail('weak_passphrase', 'Use a passphrase of at least 8 characters.');
    st.passHash = sha(st.salt + req.newPassphrase); save(req, st); return { changed: true };
  },
  upgrade: (req) => { const st = load(req); checkPass(st, req.passphrase); return { upgraded: true }; },
  rescan: (req) => { const st = load(req); checkPass(st, req.passphrase); return { rescanFrom: st.birthday }; },
  serverInfo: (req) => ({ server: 'simulated.devoid.local:443', vendor: 'simulated', version: '0', chain: req.network === 'test' ? 'test' : 'main', blockHeight: GENESIS_HEIGHT, estimatedHeight: GENESIS_HEIGHT, mode: 'direct', simulated: true }),

  sync: (req) => {
    const st = load(req);
    progress('connect');
    const h = settle(st);
    progress('scan', { height: h });
    save(req, st);
    return { synced: true, chainTip: h, blocksScanned: 0, transactionsFetched: 0, budgetExpired: false, server: 'simulated.devoid.local:443', simulated: true };
  },

  propose: (req) => {
    const st = load(req);
    const h = settle(st);
    return plan(st, h, req, 'transfer').summary;
  },

  send: (req) => {
    const st = load(req);
    checkPass(st, req.passphrase);
    progress('connect');
    const h = settle(st);
    const p = plan(st, h, req, 'transfer');
    review(p, req);
    progress('build', { recipients: p.summary.recipientCount });
    const txid = commit(st, h, p);
    progress('broadcast');
    save(req, st);
    return { txid, txids: [txid], server: 'simulated.devoid.local:443', summary: p.summary };
  },

  shield: (req) => {
    const st = load(req);
    const h = settle(st);
    if (req.dryRun) return { ...plan(st, h, req, 'shield').summary, addresses: [st.addresses.transparent] };
    checkPass(st, req.passphrase);
    const p = plan(st, h, req, 'shield');
    review(p, req);
    const txid = commit(st, h, p);
    save(req, st);
    return { txid, txids: [txid], server: 'simulated.devoid.local:443', summary: { ...p.summary, addresses: [st.addresses.transparent] } };
  },

  rebroadcast: (req) => {
    const st = load(req);
    settle(st);
    const list = Array.isArray(req.txids) ? req.txids : st.txs.filter((t) => t.minedHeight == null).map((t) => t.txid);
    return { results: list.map((txid) => ({ txid, result: { status: 'accepted' } })), server: 'simulated.devoid.local:443' };
  },

  history: (req) => {
    const st = load(req);
    const h = settle(st);
    save(req, st);
    const limit = Math.min(Math.max(Number(req.limit ?? 50), 1), 500);
    const offset = Number(req.offset ?? 0);
    let txs = [...st.txs].sort((a, b) => (a.minedHeight == null) !== (b.minedHeight == null) ? (a.minedHeight == null ? -1 : 1) : (b.minedHeight ?? b.createdHeight) - (a.minedHeight ?? a.createdHeight));
    if (req.txid) txs = txs.filter((t) => t.txid === req.txid);
    if (req.txid && txs.length === 0) throw new Fail('not_found', `The wallet has no transaction ${req.txid}.`);
    const page = txs.slice(offset, offset + limit);
    const withOut = Boolean(req.txid || req.outputs);
    return {
      chainHeight: h, hasMore: txs.length > offset + limit,
      transactions: page.map((t) => ({
        txid: t.txid, kind: t.kind, status: t.minedHeight == null ? 'pending' : 'confirmed', minedHeight: t.minedHeight ?? null,
        blockTime: t.blockTime ?? null, expiryHeight: t.expiryHeight || null,
        confirmations: t.minedHeight == null ? null : h - t.minedHeight + 1,
        balanceDeltaZat: t.delta, feeZat: t.fee, spentZat: t.spent, receivedZat: t.received,
        sentOutputs: t.outputs.filter((o) => !o.toSelf).length, receivedOutputs: t.outputs.filter((o) => o.toSelf && !o.isChange).length,
        memoCount: t.outputs.filter((o) => o.memo).length, poolCrossingZat: t.poolCrossing, zip318: null,
        ...(withOut ? { outputs: t.outputs } : {}),
      })),
    };
  },
};

// ---- planning ------------------------------------------------------------------------------
function plan(st, h, req, kind) {
  const params = st.network;
  const fee = (nIn, nOut) => 5000 * Math.max(2, nIn, nOut);
  const notes = spendable(st, h);

  if (kind === 'shield') {
    const tNotes = notes.filter((n) => n.pool === 'transparent');
    const sum = tNotes.reduce((a, n) => a + n.value, 0);
    if (sum < 20_000) throw new Fail('nothing_to_shield', 'There are no transparent funds ready to shield.');
    const f = fee(tNotes.length, 1);
    return finish({ kind, st, h, payments: [], fee: f, fundingPools: ['ironwood'], inputs: tNotes, change: [{ pool: 'ironwood', valueZat: sum - f }], chosen: tNotes, crossing: 0, transparentPaid: 0, transparentIdx: [] });
  }

  const list = req.recipients;
  if (!Array.isArray(list) || list.length === 0) throw new Fail('bad_request', 'Add at least one recipient.');
  if (list.length > MAX_RECIPIENTS) throw new Fail('too_many_recipients', `One transaction can pay at most ${MAX_RECIPIENTS} recipients; split the batch into several transactions.`);
  const payments = list.map((r, i) => {
    const bad = (why) => new Fail('bad_recipient', `Recipient ${i + 1}: ${why}`, { index: i });
    const info = parseAddress(r.address);
    if (!info.ok) throw bad(info.message);
    if (info.network !== params) throw bad(`that is a ${info.network === 'main' ? 'mainnet' : 'testnet'} address, but this wallet is on ${params === 'main' ? 'mainnet' : 'testnet'}`);
    if (info.kind === 'tex') throw bad('that is a ZIP 320 (TEX) address, which Devoid cannot pay yet');
    const amt = Number(r.amountZat);
    if (!Number.isSafeInteger(amt) || amt <= 0) throw bad('the amount must be more than zero');
    if (info.kind === 'transparent' && amt < 54) throw bad('a payment to a transparent address must be at least 54 zatoshis');
    const memo = r.memo ? String(r.memo) : null;
    if (memo && Buffer.byteLength(memo) > 512) throw bad(`the memo is ${Buffer.byteLength(memo)} bytes long; the limit is 512 bytes`);
    if (memo && !info.canReceiveMemo) throw bad('a memo cannot be sent to a transparent address');
    return { index: i, address: info.address, amountZat: amt, pool: destinationPool(info, true), memo };
  });
  const total = payments.reduce((a, p) => a + p.amountZat, 0);

  const cand = req.fundingPools?.length ? [req.fundingPools] : [['ironwood'], ['sapling'], ['ironwood', 'sapling']];
  let best = null; let short = null;
  for (const pools of cand) {
    const avail = notes.filter((n) => pools.includes(n.pool)).sort((a, b) => b.value - a.value);
    let acc = 0; const chosen = [];
    for (const n of avail) { chosen.push(n); acc += n.value; if (acc >= total + fee(chosen.length, payments.length + 1)) break; }
    const f = fee(chosen.length, payments.length + 1);
    if (acc < total + f) { short = { available: acc, required: total + f }; continue; }
    const crossing = payments.filter((p) => p.pool !== 'transparent' && !pools.includes(p.pool)).reduce((a, p) => a + p.amountZat, 0);
    const tp = payments.filter((p) => p.pool === 'transparent');
    const cr = crossing + tp.reduce((a, p) => a + p.amountZat, 0);
    if (!best || cr < best.cr) best = { pools, chosen, f, acc, crossing, tp, cr };
  }
  if (!best) {
    throw new Fail('insufficient_funds', `Not enough spendable funds: this needs ${(short.required / 1e8).toFixed(8)} ZEC including the network fee, and ${(short.available / 1e8).toFixed(8)} ZEC is spendable right now.`,
      { availableZat: short.available, requiredZat: short.required, shortfallZat: short.required - short.available });
  }
  const changePool = best.pools.includes('ironwood') ? 'ironwood' : 'sapling';
  return finish({ kind, st, h, payments, fee: best.f, fundingPools: best.pools, inputs: best.chosen, change: [{ pool: changePool, valueZat: best.acc - total - best.f }], chosen: best.chosen, crossing: best.crossing, transparentPaid: best.tp.reduce((a, p) => a + p.amountZat, 0), transparentIdx: best.tp.map((p) => p.index) });
}

function finish(c) {
  const { kind, st, h, payments, fee, fundingPools, inputs, change, crossing, transparentPaid, transparentIdx } = c;
  const by = (pool) => ({ count: inputs.filter((n) => n.pool === pool).length, valueZat: inputs.filter((n) => n.pool === pool).reduce((a, n) => a + n.value, 0) });
  const to = payments.reduce((a, p) => a + p.amountZat, 0);
  const findings = []; const requiresAck = [];
  if (kind === 'shield') findings.push({ code: 'transparent_inputs_public', severity: 'warn', message: 'The funds you are shielding are already visible on the blockchain. Shielding several transparent addresses in one transaction also shows that they belong together.', paymentIndexes: [] });
  if (transparentPaid > 0) {
    requiresAck.push('transparent_recipient');
    findings.push({ code: 'transparent_recipient', severity: 'high', message: `${transparentIdx.length} payment${transparentIdx.length === 1 ? '' : 's'} go to transparent addresses. The addresses and amounts (${(transparentPaid / 1e8).toFixed(8)} ZEC in total) will be public on the blockchain.`, paymentIndexes: transparentIdx });
  }
  if (crossing > 0) {
    requiresAck.push('pool_crossing');
    findings.push({ code: 'pool_crossing', severity: 'warn', message: `${(crossing / 1e8).toFixed(8)} ZEC moves between shielded pools (spending from ${fundingPools.join(' + ')}). Pool boundaries are visible on the blockchain, so that amount is public; the recipients and your remaining balance stay private.`, paymentIndexes: [] });
  }
  findings.push({ code: 'shape_visible', severity: 'info', message: 'Anyone can see how many inputs and outputs a transaction has (the fee reflects it). Nobody can see who the recipients are, how much each gets, or which outputs are yours.', paymentIndexes: [] });
  const level = kind === 'shield' || transparentPaid > 0 ? 'public' : crossing > 0 ? 'partial' : 'private';
  const changeTotal = change.reduce((a, x) => a + x.valueZat, 0);
  const summary = {
    kind, network: st.network, targetHeight: h + 1, ironwoodActive: true, fundingPools, recipientCount: payments.length,
    toRecipientsZat: to, feeZat: fee, changeZat: changeTotal, totalDebitZat: to + fee,
    estimatedSizeBytes: 1200 + 3100 * Math.max(payments.length + 1, inputs.length),
    inputs: { sapling: by('sapling'), orchard: { count: 0, valueZat: 0 }, ironwood: by('ironwood'), transparent: by('transparent') },
    payments: payments.map((p) => ({ index: p.index, address: p.address, amountZat: p.amountZat, pool: p.pool, memo: p.memo, memoBytes: p.memo ? Buffer.byteLength(p.memo) : null })),
    change, privacy: { level, crossingZat: crossing, transparentZat: transparentPaid, findings, requiresAck },
    simulated: true,
  };
  summary.fingerprint = sha(`devoid/proposal/1\n${canonical({ kind, payments: payments.map((p) => [p.index, p.address, p.amountZat, p.memo, p.pool]), fee, change, fundingPools, inputs: inputs.map((n) => n.id) })}`);
  return { summary, chosen: c.chosen, payments, change, fee, kind, h };
}

function review(p, req) {
  if (p.summary.fingerprint !== req.fingerprint) {
    throw new Fail('proposal_changed', 'The wallet changed since you reviewed this payment (new funds arrived, or the fee changed). Review it again.', { summary: p.summary });
  }
  const ack = new Set(Array.isArray(req.acknowledge) ? req.acknowledge : []);
  const missing = p.summary.privacy.requiresAck.filter((c) => !ack.has(c));
  if (missing.length) throw new Fail('acknowledgement_required', 'This payment reveals amounts on the blockchain; confirm that you accept that before sending.', { required: missing });
}

function commit(st, h, p) {
  const txid = randomBytes(32).toString('hex');
  for (const n of p.chosen) n.spentBy = txid;
  const ch = p.change[0];
  if (ch && ch.valueZat > 0) st.notes.push({ id: randomBytes(4).toString('hex'), pool: ch.pool, value: ch.valueZat, minedHeight: null, from: txid });
  // Notes created by this transaction become spendable once it is mined.
  const outputs = [
    ...p.payments.map((x, i) => ({ pool: x.pool, index: i, address: x.address, valueZat: x.amountZat, isChange: false, toSelf: false, memo: x.memo, memoKind: x.memo ? 'text' : null })),
    ...(ch && ch.valueZat > 0 ? [{ pool: ch.pool, index: p.payments.length, address: null, valueZat: ch.valueZat, isChange: true, toSelf: true, memo: null, memoKind: null }] : []),
  ];
  const spent = p.chosen.reduce((a, n) => a + n.value, 0);
  st.txs.push({
    txid, kind: p.kind === 'shield' ? 'shielded' : 'sent', createdHeight: h, minedHeight: null, blockTime: null, expiryHeight: h + 40,
    delta: p.kind === 'shield' ? -p.fee : -(p.payments.reduce((a, x) => a + x.amountZat, 0) + p.fee), fee: p.fee,
    spent, received: ch ? ch.valueZat : 0, outputs, poolCrossing: p.summary.privacy.crossingZat || null,
  });
  return txid;
}

// Mark change notes mined when their transaction is.
function linkNotes(st) {
  for (const n of st.notes) {
    if (n.from && n.minedHeight == null) {
      const t = st.txs.find((x) => x.txid === n.from);
      if (t?.minedHeight != null) n.minedHeight = t.minedHeight;
    }
  }
}

// ---- main ----------------------------------------------------------------------------------
async function main() {
  const arg = process.argv[2];
  let req;
  if (arg === 'version' || arg === '--version') req = { cmd: 'version' };
  else if (arg === 'selftest') req = { cmd: 'selftest' };
  else {
    let buf = '';
    for await (const chunk of process.stdin) buf += chunk;
    try { req = JSON.parse(buf); } catch { out({ ok: false, error: { code: 'bad_request', message: 'The request is not valid JSON.', details: null } }); process.exit(1); }
  }
  try {
    const fn = commands[req.cmd];
    if (!fn) throw new Fail('unknown_command', `The engine has no command "${req.cmd}".`);
    const result = fn(req);
    if (req.wallet && existsSync(file(req)) && req.cmd !== 'create') {
      const st = JSON.parse(readFileSync(file(req), 'utf8'));
      settle(st); linkNotes(st); save(req, st);
    }
    out({ ok: true, result });
  } catch (e) {
    if (e instanceof Fail) out({ ok: false, error: { code: e.code, message: e.message, details: e.details } });
    else out({ ok: false, error: { code: 'internal', message: String(e?.message ?? e), details: null } });
    process.exit(1);
  }
}
main();
