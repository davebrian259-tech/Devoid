// The wallet's request handling, independent of where it runs. The local server puts it behind
// HTTP and drives the engine as a process; the web app calls it directly with the engine in the
// page. Everything that touches the outside world (the engine, storage, waiting) is passed in.
import { parseBatchText } from './batch/csv.mjs';
import { parseAddress } from './batch/address.mjs';
import { parseZec, parseZat, formatZec } from './batch/amount.mjs';
import { toHex, utf8Length } from './batch/sha256.mjs';

export const TX_CHUNK = 25; // recipients per transaction (the engine's hard limit is 30)
export const DEFAULT_SETTINGS = { servers: 'zecrocks', mode: 'direct', socksProxy: '' };

// ---- batch planning (pure) -----------------------------------------------------------------
/** Validate pasted/imported text into recipients the UI can show row by row. */
export function validateBatch(text, network) {
  const parsed = parseBatchText(text);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
  let total = 0n;
  const rows = parsed.records.map((r) => {
    const errors = [];
    let amountZat = null;
    const a = r.amountZat ? parseZat(r.amountZat) : parseZec(r.amount);
    if (!a.ok) errors.push(a.message); else amountZat = a.zat;
    const info = parseAddress(r.address);
    let kind = null;
    if (!info.ok) errors.push(info.message);
    else {
      kind = info.kind;
      if (info.network !== network) errors.push(`This is a ${info.network === 'main' ? 'mainnet' : 'testnet'} address`);
      if (info.kind === 'tex') errors.push('TEX (ZIP 320) addresses are not supported yet');
      if (r.memo && !info.canReceiveMemo) errors.push('Transparent addresses cannot receive a memo');
    }
    if (r.memo && utf8Length(r.memo) > 512) errors.push('Memo is longer than 512 bytes');
    if (amountZat != null && errors.length === 0) total += amountZat;
    return { line: r.line, address: info.ok ? info.address : r.address, kind, label: r.label, memo: r.memo, amountZat: amountZat == null ? null : amountZat.toString(), amountZec: amountZat == null ? null : formatZec(amountZat), errors };
  });
  const seen = new Map();
  rows.forEach((r, i) => { if (!r.errors.length) { const k = `${r.address}|${r.amountZat}|${r.memo}`; if (seen.has(k)) r.warning = `Same address, amount and memo as line ${rows[seen.get(k)].line}`; else seen.set(k, i); } });
  return { ok: true, rows, valid: rows.filter((r) => !r.errors.length).length, invalid: rows.filter((r) => r.errors.length).length, totalZat: total.toString(), totalZec: formatZec(total), ignoredColumns: parsed.ignoredColumns ?? [] };
}

export function chunkRecipients(recipients, size = TX_CHUNK) {
  const out = [];
  for (let i = 0; i < recipients.length; i += size) out.push(recipients.slice(i, i + size));
  return out;
}

// What each engine progress stage means to the person waiting.
const STAGES = {
  connect: 'Connecting to the network', subtrees: 'Catching up with the chain', scan: 'Catching up with the chain',
  enhance: 'Catching up with the chain', params: 'Downloading the proving parameters (first payment only)',
  build: 'Building and proving the transaction', broadcast: 'Sending to the network',
};

const ENGINE_COMMANDS = new Set(['create', 'balance', 'addresses', 'newAddress', 'revealPhrase', 'verifyPassphrase', 'changePassphrase', 'upgrade', 'rescan', 'serverInfo', 'propose', 'shield', 'rebroadcast', 'history']);

/**
 * @param {object} o
 * @param {(request: object, onEvent?: (e: object) => void) => Promise<object>} o.run  runs one engine command
 * @param {{simulated: boolean, verified: boolean|null}} o.engineInfo
 * @param {{read(): object, write(v: object): void}} o.settings
 * @param {{read(): object, write(v: object): void}} o.lists
 * @param {string} o.wallet  the engine's wallet location
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
export function createCore({ run, engineInfo, settings, lists, wallet, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let queue = Promise.resolve();
  const jobs = new Map();
  let lastSync = { at: 0, running: null, result: null, error: null };

  const connection = () => {
    const s = { ...DEFAULT_SETTINGS, ...settings.read() };
    const mode = s.mode === 'socks5' ? `socks5://${s.socksProxy}` : s.mode;
    return { servers: s.servers, mode };
  };
  // One engine command at a time: the wallet database is not meant for concurrent writers.
  const engineCall = (req, onEvent) => {
    const p = queue.then(() => run({ wallet, connection: connection(), ...req }, onEvent));
    queue = p.catch(() => {});
    return p;
  };
  const network = async () => { const i = await engineCall({ cmd: 'info' }); return i.ok && i.result.exists ? i.result.network : null; };

  async function syncNow() {
    if (lastSync.running) return lastSync.running;
    const p = engineCall({ cmd: 'sync', budgetSecs: 25 }).then((r) => {
      lastSync = { at: Date.now(), running: null, result: r.ok ? r.result : null, error: r.ok ? null : r.error };
      return r;
    });
    lastSync.running = p;
    return p;
  }

  // Sends a whole batch as one or more transactions, in order. Each transaction is proposed again
  // right before it is built, and must still match the reviewed plan.
  function startBatch(body) {
    const id = toHex(crypto.getRandomValues(new Uint8Array(8)));
    const chunks = chunkRecipients(body.recipients);
    const job = { id, state: 'running', total: chunks.length, done: 0, txids: [], current: 0, message: 'Starting', error: null, startedAt: Date.now() };
    jobs.set(id, job);
    (async () => {
      try {
        for (let i = 0; i < chunks.length; i++) {
          job.current = i + 1;
          let sent = false; const deadline = Date.now() + 15 * 60_000;
          while (!sent) {
            job.message = chunks.length > 1 ? `Transaction ${i + 1} of ${chunks.length}` : 'Building and sending';
            await syncNow();
            const pr = await engineCall({ cmd: 'propose', recipients: chunks[i], fundingPools: body.fundingPools, padOutputs: Boolean(body.padOutputs) });
            if (!pr.ok) {
              const waiting = pr.error.code === 'insufficient_funds' && i > 0 && Date.now() < deadline;
              if (waiting) { job.message = `Waiting for change from transaction ${i} to confirm`; await sleep(8000); continue; }
              throw Object.assign(new Error(pr.error.message), { code: pr.error.code, details: pr.error.details });
            }
            const res = await engineCall({ cmd: 'send', recipients: chunks[i], fundingPools: body.fundingPools, padOutputs: Boolean(body.padOutputs), passphrase: body.passphrase, fingerprint: pr.result.fingerprint, acknowledge: body.acknowledge ?? [] }, (e) => { const what = STAGES[e.stage]; if (what) job.message = chunks.length > 1 ? `Transaction ${i + 1} of ${chunks.length}: ${what.toLowerCase()}` : what; });
            if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code, details: res.error.details });
            job.txids.push(...(res.result.txids ?? [res.result.txid])); job.done = i + 1; sent = true;
          }
        }
        job.state = 'done'; job.message = 'Sent';
      } catch (e) {
        job.state = 'failed'; job.error = { code: e.code ?? 'send_failed', message: e.message, details: e.details ?? null };
        job.message = job.done > 0 ? `${job.done} of ${job.total} transactions were sent before this stopped` : 'Nothing was sent';
      }
      body.passphrase = null;
    })();
    return job;
  }

  const ok = (v, status = 200) => ({ status, body: v });
  const fail = (status, code, message, details = null) => ({ status, body: { ok: false, error: { code, message, details } } });

  /** Handles one API request; returns the HTTP status and the JSON body. */
  async function handle(path, body = {}) {
    switch (path) {
      case '/api/status': {
        const info = await engineCall({ cmd: 'info' });
        return ok({ ok: true, result: { simulated: engineInfo.simulated, engineVerified: engineInfo.simulated ? false : engineInfo.verified === true, wallet: info.ok ? info.result : { exists: false }, settings: { ...DEFAULT_SETTINGS, ...settings.read() }, sync: { at: lastSync.at, running: !!lastSync.running, error: lastSync.error }, chunkSize: TX_CHUNK } });
      }
      case '/api/settings': {
        if (body && typeof body === 'object' && 'mode' in body) {
          const s = { ...DEFAULT_SETTINGS, ...settings.read() };
          if (!['direct', 'tor', 'socks5'].includes(body.mode)) return fail(400, 'bad_request', 'Unknown connection mode.');
          if (body.mode === 'socks5' && !/^[\w.\-\[\]:]+:\d{1,5}$/.test(String(body.socksProxy ?? ''))) return fail(400, 'bad_request', 'Enter the proxy as host:port.');
          s.mode = body.mode; s.socksProxy = String(body.socksProxy ?? '');
          if (typeof body.servers === 'string' && body.servers.length < 300) s.servers = body.servers;
          settings.write(s);
        }
        return ok({ ok: true, result: { ...DEFAULT_SETTINGS, ...settings.read() } });
      }
      case '/api/sync': {
        const r = await syncNow(); return ok(r);
      }
      case '/api/batch/validate': {
        const net = await network();
        if (!net) return fail(409, 'no_wallet', 'Create or restore a wallet first.');
        return ok({ ok: true, result: validateBatch(String(body.text ?? ''), net) });
      }
      case '/api/batch/plan': {
        const recipients = body.recipients;
        if (!Array.isArray(recipients) || !recipients.length) return fail(400, 'bad_request', 'Add at least one recipient.');
        if (recipients.length > 2000) return fail(400, 'too_many_recipients', 'A batch can have at most 2,000 recipients.');
        const chunks = chunkRecipients(recipients);
        const first = await engineCall({ cmd: 'propose', recipients: chunks[0], fundingPools: body.fundingPools, padOutputs: Boolean(body.padOutputs) });
        if (!first.ok) return ok(first);
        // Later transactions spend change from earlier ones, so they cannot be proposed yet; their
        // fee is estimated from the first one.
        const f = first.result;
        const per = f.feeZat;
        return ok({ ok: true, result: { transactions: chunks.length, chunkSize: TX_CHUNK, recipients: recipients.length, first: f, estimatedFeeZat: chunks.length === 1 ? per : per * chunks.length, feeIsEstimate: chunks.length > 1, needsAck: f.privacy?.requiresAck ?? [], sequential: chunks.length > 1 } });
      }
      case '/api/batch/send': {
        if (!Array.isArray(body.recipients) || !body.recipients.length) return fail(400, 'bad_request', 'Add at least one recipient.');
        if (typeof body.passphrase !== 'string' || !body.passphrase) return fail(400, 'bad_request', 'Enter your passphrase.');
        // Check the passphrase and acknowledgements up front so a wrong one fails fast, not mid-batch.
        const chunks = chunkRecipients(body.recipients);
        const pr = await engineCall({ cmd: 'propose', recipients: chunks[0], fundingPools: body.fundingPools, padOutputs: Boolean(body.padOutputs) });
        if (!pr.ok) return ok(pr);
        const need = pr.result.privacy?.requiresAck ?? [];
        const have = new Set(body.acknowledge ?? []);
        const missing = need.filter((c) => !have.has(c));
        if (missing.length) return fail(409, 'acknowledgement_required', 'Confirm that you accept what this payment reveals before sending.', { required: missing });
        const pk = await engineCall({ cmd: 'verifyPassphrase', passphrase: body.passphrase }).then((r) => (r.ok ? null : r.error));
        if (pk) return ok({ ok: false, error: pk });
        if ([...jobs.values()].some((j) => j.state === 'running')) return fail(409, 'busy', 'A batch is already being sent.');
        const job = startBatch(body);
        return ok({ ok: true, result: { jobId: job.id } });
      }
      case '/api/batch/job': {
        const j = jobs.get(String(body.jobId));
        if (!j) return fail(404, 'not_found', 'Unknown job.');
        return ok({ ok: true, result: j });
      }
      case '/api/lists': {
        const store = lists.read();
        if (body && (body.lists || body.contacts)) {
          if (Array.isArray(body.lists) && body.lists.length <= 500) store.lists = body.lists;
          if (Array.isArray(body.contacts) && body.contacts.length <= 5000) store.contacts = body.contacts;
          lists.write(store);
        }
        return ok({ ok: true, result: store });
      }
      default: {
        const cmd = path.slice('/api/engine/'.length);
        if (!path.startsWith('/api/engine/') || !ENGINE_COMMANDS.has(cmd)) return fail(404, 'not_found', 'Unknown endpoint.');
        const r = await engineCall({ ...body, cmd, wallet, connection: connection() });
        return ok(r);
      }
    }
  }

  return { handle };
}
