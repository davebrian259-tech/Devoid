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
import { createCore, validateBatch, chunkRecipients, TX_CHUNK, DEFAULT_SETTINGS } from './core.mjs';

export { validateBatch, chunkRecipients, TX_CHUNK };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT, 'ui');

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

// ---- stores --------------------------------------------------------------------------------
function jsonStore(path, fallback) {
  const read = () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return structuredClone(fallback); } };
  const write = (v) => { mkdirSync(dirname(path), { recursive: true }); const t = `${path}.tmp`; writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 }); renameSync(t, path); };
  return { read, write };
}

// ---- app -----------------------------------------------------------------------------------
export function createApp({ dataDir, engine, verified = engine?.simulated ? null : true, token = randomBytes(24).toString('base64url'), port = 0 } = {}) {
  const wallet = join(dataDir, 'wallet');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const settingsStore = jsonStore(join(dataDir, 'settings.json'), DEFAULT_SETTINGS);
  const listsStore = jsonStore(join(dataDir, 'lists.json'), { lists: [], contacts: [] });
  let allowedHosts = new Set();
  const core = createCore({
    run: (request, onEvent) => runEngine(engine, request, onEvent),
    engineInfo: { simulated: engine.simulated, verified },
    settings: settingsStore, lists: listsStore, wallet,
  });
  const fail = (res, status, code, message, details = null) => send(res, status, { ok: false, error: { code, message, details } });

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
        const r = await core.handle(url.pathname, body ?? {});
        return send(res, r.status, r.body);
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
