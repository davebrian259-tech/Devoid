// Runs the Devoid wallet engine (Rust, compiled to WebAssembly) off the page's main thread, so
// syncing and proving never freeze the screen. The page sends one request at a time:
//   { id, type: 'run', request }  ->  { id, event } (progress, any number)  then  { id, result }
//   { id, type: 'reset' }         ->  { id, result }
//   { id, type: 'checkProving' }  ->  { id, result }   builds and proves a throw-away transaction
// The wallet folder lives in this browser's IndexedDB: loaded into the engine on start, saved after
// every command that can change it. The recovery phrase is in it only inside keys.json, encrypted
// with the passphrase, as on disk in the desktop app. Nothing else leaves this worker except
// requests to the lightwalletd server the wallet is set to use, and to this site for the Sapling
// parameters.
import init, { run, checkProving, setParamLoader, importFile, exportFiles, clearFiles, enableLogging } from './devoid_web_engine.js';

const DB_NAME = 'devoid-wallet';
const STORE = 'files';
// Commands that only read; everything else may change the wallet and is followed by a save.
const READ_ONLY = new Set(['version', 'info', 'balance', 'addresses', 'history', 'revealPhrase', 'verifyPassphrase', 'serverInfo', 'propose', 'selftest']);

function idb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function tx(db, mode, work) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = work(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function loadAll(db) {
  const store = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly').objectStore(STORE);
    const keys = t.getAllKeys(); const values = t.getAll();
    values.onsuccess = () => resolve(keys.result.map((k, i) => [k, values.result[i]]));
    values.onerror = () => reject(values.error);
  });
  return store;
}

/** Saves the engine's files, and deletes saved ones the engine no longer has. */
async function saveAll(db) {
  const files = exportFiles();
  const names = new Set(files.map(([path]) => path));
  const saved = await tx(db, 'readonly', (s) => s.getAllKeys());
  await tx(db, 'readwrite', (s) => {
    for (const [path, bytes] of files) s.put(bytes, path);
    for (const old of saved) if (!names.has(old)) s.delete(old);
  });
}

// The Sapling spend parameters are larger than one file may be on the host, so they are served
// in two parts. The engine checks the joined bytes against the published hash.
const PARAM_PARTS = { 'sapling-output.params': ['sapling-output.params'], 'sapling-spend.params': ['sapling-spend.params.0', 'sapling-spend.params.1'] };

async function loadParams(name) {
  const parts = PARAM_PARTS[name];
  if (!parts) throw new Error(`unknown parameter file ${name}`);
  const chunks = [];
  for (const part of parts) {
    const r = await fetch(new URL(`params/${part}`, import.meta.url));
    if (!r.ok) throw new Error(`${part}: HTTP ${r.status}`);
    chunks.push(new Uint8Array(await r.arrayBuffer()));
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const ready = (async () => {
  await init();
  // The engine's log, for troubleshooting: open the wallet with ?log=info (or debug) in the URL.
  const level = /log=(\w+)/.exec(self.name)?.[1];
  if (level) enableLogging(level);
  setParamLoader(loadParams);
  const db = await idb();
  for (const [path, bytes] of await loadAll(db)) importFile(path, bytes);
  return db;
})();

self.onmessage = async ({ data }) => {
  const { id, type, request } = data;
  let db;
  try {
    db = await ready;
  } catch (e) {
    postMessage({ id, result: { ok: false, error: { code: 'engine_unavailable', message: 'The wallet engine could not start in this browser.', details: { reason: String(e?.message ?? e) } } } });
    return;
  }
  try {
    if (type === 'reset') {
      clearFiles();
      await tx(db, 'readwrite', (s) => s.clear());
      postMessage({ id, result: { ok: true, result: { reset: true } } });
      return;
    }
    if (type === 'checkProving') {
      postMessage({ id, result: JSON.parse(await checkProving((line) => postMessage({ id, event: JSON.parse(line) }))) });
      return;
    }
    const final = await run(JSON.stringify(request), (line) => postMessage({ id, event: JSON.parse(line) }));
    const result = JSON.parse(final);
    if (!READ_ONLY.has(request.cmd)) await saveAll(db);
    postMessage({ id, result });
  } catch (e) {
    // A panic aborts the WebAssembly module; this worker is finished. The page starts a new one,
    // which reloads the wallet as it was last saved.
    postMessage({ id, result: { ok: false, error: { code: 'internal', message: 'The wallet engine stopped unexpectedly. Nothing was sent; please try again.', details: null } }, crashed: true });
    self.close();
  }
};
