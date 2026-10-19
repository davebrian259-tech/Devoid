// The web app's backend: the same request core the desktop server uses, with the wallet engine
// running in this browser. Nothing goes through a Devoid server. There are two engines:
//
//  * real: the Devoid engine itself (the Rust wallet code of the desktop app, compiled to
//    WebAssembly) in a Web Worker. It talks to a lightwalletd server over gRPC-web and keeps the
//    wallet in this browser's IndexedDB, keys encrypted with the passphrase.
//  * demo: the simulated engine, with play money on a made-up chain, in this browser's storage.
//
// Rules that hold whatever the page asks: the demo is testnet only, so nobody can send real ZEC to
// a demo address that no one can spend from; and a recovery phrase is never accepted, so the web
// version never invites anyone to type a real one into a website.
import { createCore } from '../../server/core.mjs';
import { createSimEngine } from '../../mock-engine/core.mjs';

const PREFIX = 'devoid-web:';
export const ENGINES = ['real', 'demo'];
const memory = new Map(); // used when the browser blocks storage; the wallet then lasts one visit
const store = {
  get(key) { try { return localStorage.getItem(PREFIX + key); } catch { return memory.get(key) ?? null; } },
  set(key, value) { try { localStorage.setItem(PREFIX + key, value); } catch { memory.set(key, value); } },
};
const json = (key, fallback) => ({
  read: () => { try { return JSON.parse(store.get(key)) ?? structuredClone(fallback); } catch { return structuredClone(fallback); } },
  write: (v) => store.set(key, JSON.stringify(v)),
});

/** Which engine this browser uses; null until the person has chosen. */
export const engineChoice = () => (ENGINES.includes(store.get('engine')) ? store.get('engine') : null);

function simEngine() {
  return createSimEngine({
    exists: (wallet) => Boolean(wallet) && store.get(`engine:${wallet}`) != null,
    read: (wallet) => store.get(`engine:${wallet}`),
    write: (wallet, text) => store.set(`engine:${wallet}`, text),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  });
}

/** The real engine, in a Web Worker (ui/engine/worker.js). Started on first use. */
function wasmEngine() {
  let worker = null; let next = 0;
  const pending = new Map();
  const start = () => {
    // ?log=info (or debug) in the page's address sends the engine's log to the console.
    const log = /^\w+$/.exec(new URLSearchParams(location.search).get('log') ?? '')?.[0];
    worker = new Worker(new URL('../engine/worker.js', import.meta.url), { type: 'module', name: log ? `log=${log}` : '' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.event) { p.onEvent?.(data.event); return; }
      pending.delete(data.id);
      if (data.crashed) worker = null; // the next request starts a fresh worker
      p.resolve(data.result);
    };
    // A panic aborts the WebAssembly module; this worker is finished. The next request starts a
    // fresh one, which reloads the wallet as it was last saved.
    worker.onerror = () => {
      for (const [, p] of pending) p.resolve({ ok: false, error: { code: 'internal', message: 'The wallet engine stopped unexpectedly. Nothing was sent; please try again.', details: null } });
      pending.clear(); worker?.terminate(); worker = null;
    };
  };
  const send = (message, onEvent) => new Promise((resolve) => {
    if (!worker) start();
    const id = ++next;
    pending.set(id, { resolve, onEvent });
    worker.postMessage({ id, ...message });
  });
  return {
    run: (request, onEvent) => send({ type: 'run', request }, onEvent),
    reset: () => send({ type: 'reset' }),
  };
}

const ENGINE = {
  real: { make: wasmEngine, simulated: false, settings: { servers: 'chainsafe' } },
  demo: { make: simEngine, simulated: true, settings: {} },
};

export function createBackend() {
  let kind = engineChoice();
  let engine = null; let core = null;
  const build = () => {
    const spec = ENGINE[kind ?? 'demo'];
    engine = spec.make();
    // Each engine keeps its own settings, lists and contacts: demo addresses never mix with real ones.
    const ns = kind === 'real' ? 'real:' : '';
    core = createCore({
      run: async (request, onEvent) => engine.run(request, onEvent),
      engineInfo: { simulated: spec.simulated, verified: null },
      settings: json(`${ns}settings`, spec.settings),
      lists: json(`${ns}lists`, { lists: [], contacts: [] }),
      wallet: 'wallet',
    });
  };
  build();

  return {
    async call(path, body = {}) {
      const req = structuredClone(body ?? {});
      if (path === '/api/web/engine') {
        if (!ENGINES.includes(req.engine)) return { ok: false, error: { code: 'bad_request', message: 'Unknown engine.', details: null } };
        if (req.engine !== kind) { kind = req.engine; store.set('engine', kind); build(); }
        return { ok: true, result: { engine: kind } };
      }
      if (path === '/api/engine/create') {
        if (req.phrase) return { ok: false, error: { code: 'restore_unavailable', message: 'The web version never asks for a recovery phrase. Restore your wallet in the desktop app.', details: null } };
        // The demo's addresses belong to nobody; only the real engine may hold real ZEC.
        req.network = kind === 'real' && req.network === 'main' ? 'main' : 'test';
      }
      if (path === '/api/settings' && kind === 'real' && req.mode && req.mode !== 'direct') {
        return { ok: false, error: { code: 'bad_request', message: 'Tor and SOCKS5 are not available in a browser. Use the desktop app to hide your IP address from the server.', details: null } };
      }
      const r = structuredClone((await core.handle(path, req)).body);
      if (path === '/api/status' && r.ok) r.result.webEngine = kind;
      return r;
    },
    /** Deletes this browser's wallet, lists, contacts and settings, for both engines. */
    async reset() {
      if (kind === 'real') await engine.reset();
      else await deleteSavedRealWallet();
      clearStorage();
      kind = null; build();
    },
  };
}

// The real engine's saved wallet is in IndexedDB; a reset from the demo removes it too, in case
// one was made earlier in this browser.
async function deleteSavedRealWallet() {
  try {
    await new Promise((resolve) => { const r = indexedDB.deleteDatabase('devoid-wallet'); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  } catch { /* nothing stored */ }
}

function clearStorage() {
  memory.clear();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* nothing stored */ }
}

/** Deletes the demo wallet, its lists, contacts and settings from this browser (no real wallet). */
export function resetDemo() {
  clearStorage();
}
