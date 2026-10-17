#!/usr/bin/env node
// Devoid local server: serves the UI and a small JSON API over 127.0.0.1, and drives the engine
// (the real Rust `devoid-engine` if it is built, otherwise the simulated one). Zero dependencies.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, dirname, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { parseBatchText } from './batch/csv.mjs';
import { parseAddress } from './batch/address.mjs';
import { parseZec, parseZat, formatZec } from './batch/amount.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT, 'ui');
export const TX_CHUNK = 25; // recipients per transaction (the engine's hard limit is 30)

// ---- engine runner -------------------------------------------------------------------------
export function pickEngine({ forceMock = false, env = process.env } = {}) {
  const real = env.DEVOID_ENGINE || join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'devoid-engine.exe' : 'devoid-engine');
  if (!forceMock && existsSync(real)) return { simulated: false, cmd: real, args: [] };
  return { simulated: true, cmd: process.execPath, args: [join(ROOT, 'mock-engine', 'engine.mjs')] };
}

/** Runs the engine's self-test. A real engine that fails it must not be used for money. */
export async function verifyEngine(engine) {
  if (engine.simulated) return { ok: true, simulated: true };
  const r = await runEngine(engine, { cmd: 'selftest' });
  return r.ok ? { ok: true, simulated: false } : { ok: false, simulated: false, error: r.error };
}

const TIMEOUT = { sync: 330_000, send: 330_000, shield: 330_000, rescan: 600_000, create: 120_000, upgrade: 120_000 };

export function runEngine(engine, request, onEvent = () => {}) {
  return new Promise((res) => {
    const timeoutMs = TIMEOUT[request.cmd] ?? 90_000;
    const child = spawn(engine.cmd, engine.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    let buf = ''; let last = null; let size = 0; let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); res(v); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: { code: 'engine_timeout', message: 'The wallet engine took too long and was stopped.', details: null } }); }, timeoutMs);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > 64 * 1024 * 1024) { child.kill('SIGKILL'); return; }
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { const o = JSON.parse(line); if (o.event === 'progress') onEvent(o); else last = o; } catch { /* ignore junk */ }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (e) => finish({ ok: false, error: { code: 'engine_missing', message: `The wallet engine could not be started: ${e.message}`, details: null } }));
    child.on('close', () => finish(last ?? { ok: false, error: { code: 'engine_crashed', message: 'The wallet engine stopped without an answer. Nothing was sent.', details: null } }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

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
    let pool = null; let kind = null;
    if (!info.ok) errors.push(info.message);
    else {
      kind = info.kind;
      if (info.network !== network) errors.push(`This is a ${info.network === 'main' ? 'mainnet' : 'testnet'} address`);
      if (info.kind === 'tex') errors.push('TEX (ZIP 320) addresses are not supported yet');
      if (r.memo && !info.canReceiveMemo) errors.push('Transparent addresses cannot receive a memo');
    }
    if (r.memo && Buffer.byteLength(r.memo) > 512) errors.push('Memo is longer than 512 bytes');
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

// ---- stores --------------------------------------------------------------------------------
function jsonStore(path, fallback) {
  const read = () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return structuredClone(fallback); } };
  const write = (v) => { mkdirSync(dirname(path), { recursive: true }); const t = `${path}.tmp`; writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 }); renameSync(t, path); };
  return { read, write };
}

const DEFAULT_SETTINGS = { servers: 'zecrocks', mode: 'direct', socksProxy: '' };

// ---- app -----------------------------------------------------------------------------------
export function createApp({ dataDir, engine, verified = engine?.simulated ? null : true, token = randomBytes(24).toString('base64url'), port = 0 } = {}) {
  const wallet = join(dataDir, 'wallet');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const settingsStore = jsonStore(join(dataDir, 'settings.json'), DEFAULT_SETTINGS);
  const listsStore = jsonStore(join(dataDir, 'lists.json'), { lists: [], contacts: [] });
  let queue = Promise.resolve();
  const jobs = new Map();
  let lastSync = { at: 0, running: null, result: null, error: null };
  let allowedHosts = new Set();

  const connection = () => {
    const s = { ...DEFAULT_SETTINGS, ...settingsStore.read() };
    const mode = s.mode === 'socks5' ? `socks5://${s.socksProxy}` : s.mode;
    return { servers: s.servers, mode };
  };
  // One engine process at a time: the wallet database is not meant for concurrent writers.
  const engineCall = (req, onEvent) => {
    const run = queue.then(() => runEngine(engine, { wallet, connection: connection(), ...req }, onEvent));
    queue = run.catch(() => {});
    return run;
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
    const id = randomBytes(8).toString('hex');
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
            const pr = await engineCall({ cmd: 'propose', recipients: chunks[i], fundingPools: body.fundingPools });
            if (!pr.ok) {
              const waiting = pr.error.code === 'insufficient_funds' && i > 0 && Date.now() < deadline;
              if (waiting) { job.message = `Waiting for change from transaction ${i} to confirm`; await new Promise((r) => setTimeout(r, 8000)); continue; }
              throw Object.assign(new Error(pr.error.message), { code: pr.error.code, details: pr.error.details });
            }
            const res = await engineCall({ cmd: 'send', recipients: chunks[i], fundingPools: body.fundingPools, passphrase: body.passphrase, fingerprint: pr.result.fingerprint, acknowledge: body.acknowledge ?? [] }, (e) => { job.message = e.stage; });
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

  const ok = (res, v, status = 200) => send(res, status, v);
  const fail = (res, status, code, message, details = null) => send(res, status, { ok: false, error: { code, message, details } });

  async function api(req, res, path, body) {
    switch (path) {
      case '/api/status': {
        const info = await engineCall({ cmd: 'info' });
        return ok(res, { ok: true, result: { simulated: engine.simulated, engineVerified: engine.simulated ? false : verified === true, wallet: info.ok ? info.result : { exists: false }, settings: { ...DEFAULT_SETTINGS, ...settingsStore.read() }, sync: { at: lastSync.at, running: !!lastSync.running, error: lastSync.error }, chunkSize: TX_CHUNK } });
      }
      case '/api/settings': {
        if (body && typeof body === 'object' && 'mode' in body) {
          const s = { ...DEFAULT_SETTINGS, ...settingsStore.read() };
          if (!['direct', 'tor', 'socks5'].includes(body.mode)) return fail(res, 400, 'bad_request', 'Unknown connection mode.');
          if (body.mode === 'socks5' && !/^[\w.\-\[\]:]+:\d{1,5}$/.test(String(body.socksProxy ?? ''))) return fail(res, 400, 'bad_request', 'Enter the proxy as host:port.');
          s.mode = body.mode; s.socksProxy = String(body.socksProxy ?? '');
          if (typeof body.servers === 'string' && body.servers.length < 300) s.servers = body.servers;
          settingsStore.write(s);
        }
        return ok(res, { ok: true, result: { ...DEFAULT_SETTINGS, ...settingsStore.read() } });
      }
      case '/api/sync': {
        const r = await syncNow(); return ok(res, r);
      }
      case '/api/batch/validate': {
        const net = await network();
        if (!net) return fail(res, 409, 'no_wallet', 'Create or restore a wallet first.');
        return ok(res, { ok: true, result: validateBatch(String(body.text ?? ''), net) });
      }
      case '/api/batch/plan': {
        const recipients = body.recipients;
        if (!Array.isArray(recipients) || !recipients.length) return fail(res, 400, 'bad_request', 'Add at least one recipient.');
        if (recipients.length > 2000) return fail(res, 400, 'too_many_recipients', 'A batch can have at most 2,000 recipients.');
        const chunks = chunkRecipients(recipients);
        const first = await engineCall({ cmd: 'propose', recipients: chunks[0], fundingPools: body.fundingPools });
        if (!first.ok) return ok(res, first);
        // Later transactions spend change from earlier ones, so they cannot be proposed yet; their
        // fee is estimated from the first one.
        const f = first.result;
        const per = f.feeZat;
        return ok(res, { ok: true, result: { transactions: chunks.length, chunkSize: TX_CHUNK, recipients: recipients.length, first: f, estimatedFeeZat: chunks.length === 1 ? per : per * chunks.length, feeIsEstimate: chunks.length > 1, needsAck: f.privacy?.requiresAck ?? [], sequential: chunks.length > 1 } });
      }
      case '/api/batch/send': {
        if (!Array.isArray(body.recipients) || !body.recipients.length) return fail(res, 400, 'bad_request', 'Add at least one recipient.');
        if (typeof body.passphrase !== 'string' || !body.passphrase) return fail(res, 400, 'bad_request', 'Enter your passphrase.');
        // Check the passphrase and acknowledgements up front so a wrong one fails fast, not mid-batch.
        const chunks = chunkRecipients(body.recipients);
        const pr = await engineCall({ cmd: 'propose', recipients: chunks[0], fundingPools: body.fundingPools });
        if (!pr.ok) return ok(res, pr);
        const need = pr.result.privacy?.requiresAck ?? [];
        const have = new Set(body.acknowledge ?? []);
        const missing = need.filter((c) => !have.has(c));
        if (missing.length) return fail(res, 409, 'acknowledgement_required', 'Confirm that you accept what this payment reveals before sending.', { required: missing });
        const pk = await engineCall({ cmd: 'revealPhrase', passphrase: body.passphrase }).then((r) => (r.ok ? null : r.error));
        if (pk) return ok(res, { ok: false, error: pk });
        if ([...jobs.values()].some((j) => j.state === 'running')) return fail(res, 409, 'busy', 'A batch is already being sent.');
        const job = startBatch(body);
        return ok(res, { ok: true, result: { jobId: job.id } });
      }
      case '/api/batch/job': {
        const j = jobs.get(String(body.jobId));
        if (!j) return fail(res, 404, 'not_found', 'Unknown job.');
        return ok(res, { ok: true, result: j });
      }
      case '/api/lists': {
        const store = listsStore.read();
        if (body && (body.lists || body.contacts)) {
          if (Array.isArray(body.lists) && body.lists.length <= 500) store.lists = body.lists;
          if (Array.isArray(body.contacts) && body.contacts.length <= 5000) store.contacts = body.contacts;
          listsStore.write(store);
        }
        return ok(res, { ok: true, result: store });
      }
      default: {
        const cmd = path.slice('/api/engine/'.length);
        const allowed = new Set(['create', 'balance', 'addresses', 'newAddress', 'revealPhrase', 'changePassphrase', 'upgrade', 'rescan', 'serverInfo', 'propose', 'shield', 'rebroadcast', 'history']);
        if (!path.startsWith('/api/engine/') || !allowed.has(cmd)) return fail(res, 404, 'not_found', 'Unknown endpoint.');
        const r = await engineCall({ ...body, cmd, wallet, connection: connection() });
        return ok(res, r);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host ?? '');
      if (!allowedHosts.has(host)) return fail(res, 403, 'forbidden', 'Unexpected host.');
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Use POST.');
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) return fail(res, 403, 'forbidden', 'Unexpected origin.');
        const auth = String(req.headers.authorization ?? '');
        const given = Buffer.from(auth.replace(/^Bearer /, '')); const want = Buffer.from(token);
        if (given.length !== want.length || !timingSafeEqual(given, want)) return fail(res, 401, 'unauthorized', 'Open Devoid from the link the server printed.');
        if (!/^application\/json/.test(String(req.headers['content-type'] ?? ''))) return fail(res, 415, 'bad_request', 'Send JSON.');
        let raw = ''; let tooBig = false;
        for await (const c of req) { raw += c; if (raw.length > 3_000_000) { tooBig = true; break; } }
        if (tooBig) return fail(res, 413, 'bad_request', 'Request too large.');
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { return fail(res, 400, 'bad_request', 'Invalid JSON.'); }
        return await api(req, res, url.pathname, body ?? {});
      }
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Use GET.');
      return serveStatic(res, url.pathname);
    } catch (e) {
      fail(res, 500, 'internal', 'Something went wrong in the local server.');
    }
  });

  return {
    token, server, engine, wallet,
    listen: () => new Promise((r) => server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
      r(p);
    })),
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }),
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HEADERS = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin' };

function send(res, status, obj) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const full = normalize(join(UI_DIR, rel));
  if (!full.startsWith(UI_DIR + '/') || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  res.writeHead(200, { ...HEADERS, 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' });
  res.end(readFileSync(full));
}

// ---- main ----------------------------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const portArg = args.find((a) => a.startsWith('--port='));
  const engine = pickEngine({ forceMock: demo || args.includes('--mock') });
  if (!engine.simulated) {
    const v = await verifyEngine(engine);
    if (!v.ok) {
      console.error(`\n  The wallet engine failed its self-test and will not be used for real funds:\n  ${v.error?.message ?? 'unknown error'}\n  Fix the engine, or run with --demo for the simulated chain.\n`);
      process.exit(1);
    }
  }
  const dataDir = process.env.DEVOID_HOME || (demo ? join(ROOT, '.demo-data') : join(os.homedir(), '.devoid'));
  const app = createApp({ dataDir, engine, port: portArg ? Number(portArg.slice(7)) : 8787 });
  app.server.on('error', async (e) => {
    if (e.code === 'EADDRINUSE') { const alt = createApp({ dataDir, engine, token: app.token, port: 0 }); const p = await alt.listen(); banner(p, alt.token); } else throw e;
  });
  const banner = (p, t) => {
    console.log(`\n  Devoid is running${engine.simulated ? ' with the SIMULATED engine (no real network, no real money)' : ''}.`);
    console.log(`  Open:  http://127.0.0.1:${p}/#token=${t}\n  Data:  ${dataDir}\n`);
  };
  app.listen().then((p) => banner(p, app.token)).catch(() => {});
}
