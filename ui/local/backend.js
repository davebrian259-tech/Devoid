// The web app's backend: the same request core the desktop server uses, and the simulated engine,
// both running in this page. State lives in this browser's storage. Nothing is sent anywhere.
//
// Two rules hold here whatever the page asks: wallets are testnet only, so nobody can send real
// ZEC to a demo address that no one can spend from; and a recovery phrase is never accepted, so
// the web version never invites anyone to type a real one into a website.
import { createCore } from '../../server/core.mjs';
import { createSimEngine } from '../../mock-engine/core.mjs';

const PREFIX = 'devoid-web:';
const memory = new Map(); // used when the browser blocks storage; the demo then lasts one visit
const store = {
  get(key) { try { return localStorage.getItem(PREFIX + key); } catch { return memory.get(key) ?? null; } },
  set(key, value) { try { localStorage.setItem(PREFIX + key, value); } catch { memory.set(key, value); } },
};
const json = (key, fallback) => ({
  read: () => { try { return JSON.parse(store.get(key)) ?? structuredClone(fallback); } catch { return structuredClone(fallback); } },
  write: (v) => store.set(key, JSON.stringify(v)),
});

const engine = createSimEngine({
  exists: (wallet) => Boolean(wallet) && store.get(`engine:${wallet}`) != null,
  read: (wallet) => store.get(`engine:${wallet}`),
  write: (wallet, text) => store.set(`engine:${wallet}`, text),
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
});

export function createBackend() {
  const core = createCore({
    run: async (request, onEvent) => engine.run(request, onEvent),
    engineInfo: { simulated: true, verified: null },
    settings: json('settings', {}),
    lists: json('lists', { lists: [], contacts: [] }),
    wallet: 'wallet',
  });
  return {
    async call(path, body = {}) {
      const req = structuredClone(body ?? {});
      if (path === '/api/engine/create') {
        if (req.phrase) return { ok: false, error: { code: 'restore_unavailable', message: 'The web version never asks for a recovery phrase. Restore your wallet in the desktop app.', details: null } };
        req.network = 'test';
      }
      // Answers are copied, like an HTTP response, so the page can never change the core's state.
      return structuredClone((await core.handle(path, req)).body);
    },
  };
}

/** Deletes the demo wallet, its lists, contacts and settings from this browser. */
export function resetDemo() {
  memory.clear();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* nothing stored */ }
}
