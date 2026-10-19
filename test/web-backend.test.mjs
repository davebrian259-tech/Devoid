// The web app's backend: the request core and the simulated engine composed in one process, with
// browser storage. Checks the two rules the web version must keep whatever the page sends.
import test from 'node:test';
import assert from 'node:assert/strict';

const data = new Map();
globalThis.localStorage = {
  getItem: (k) => (data.has(k) ? data.get(k) : null),
  setItem: (k, v) => data.set(k, String(v)),
  removeItem: (k) => data.delete(k),
  key: (i) => [...data.keys()][i] ?? null,
  get length() { return data.size; },
};
// Object.keys(localStorage) in a browser lists the stored keys; mirror that.
globalThis.localStorage = new Proxy(globalThis.localStorage, { ownKeys: () => [...data.keys()], getOwnPropertyDescriptor: (t, k) => (data.has(k) ? { enumerable: true, configurable: true, value: data.get(k) } : Reflect.getOwnPropertyDescriptor(t, k)) });

const { createBackend, resetDemo } = await import('../ui/local/backend.js');

test('the web backend creates testnet wallets only, and never accepts a recovery phrase', async () => {
  resetDemo();
  const api = createBackend();
  assert.equal((await api.call('/api/status')).result.wallet.exists, false);
  const restore = await api.call('/api/engine/create', { passphrase: 'demo passphrase', network: 'test', phrase: 'abandon '.repeat(23) + 'art' });
  assert.equal(restore.ok, false);
  assert.equal(restore.error.code, 'restore_unavailable');
  assert.equal(data.size, 0, 'a refused restore stores nothing');

  const made = await api.call('/api/engine/create', { passphrase: 'demo passphrase', network: 'main' });
  assert.equal(made.ok, true);
  assert.equal(made.result.network, 'test', 'a mainnet request is created on testnet');
  assert.match(made.result.addresses.shielded, /^utest1/);
  const st = await api.call('/api/status');
  assert.equal(st.result.simulated, true);
  assert.equal(st.result.wallet.network, 'test');
});

test('the web backend sends a batch and keeps the wallet across page loads', async () => {
  resetDemo();
  const api = createBackend();
  await api.call('/api/engine/create', { passphrase: 'demo passphrase' });
  const to = (await api.call('/api/engine/newAddress')).result.shielded;
  const v = await api.call('/api/batch/validate', { text: `${to},0.5,thanks\n${to},0.25` });
  assert.equal(v.result.valid, 2);
  const recipients = v.result.rows.map((r) => ({ address: r.address, amountZat: r.amountZat, memo: r.memo }));
  const plan = await api.call('/api/batch/plan', { recipients });
  assert.equal(plan.ok, true, JSON.stringify(plan.error));
  assert.equal(plan.result.first.feeZat, 15000); // ZIP 317: two payments plus change, 5,000 zat each
  const wrong = await api.call('/api/batch/send', { recipients, passphrase: 'not it at all', acknowledge: plan.result.needsAck });
  assert.equal(wrong.error.code, 'wrong_passphrase');
  const sent = await api.call('/api/batch/send', { recipients, passphrase: 'demo passphrase', acknowledge: plan.result.needsAck });
  assert.equal(sent.ok, true, JSON.stringify(sent.error));
  let job;
  for (let i = 0; i < 50; i++) { job = (await api.call('/api/batch/job', { jobId: sent.result.jobId })).result; if (job.state !== 'running') break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(job.state, 'done');
  assert.equal(job.txids.length, 1);

  // A new page load builds a new backend over the same storage.
  const again = createBackend();
  const hist = await again.call('/api/engine/history', { limit: 10 });
  assert.ok(hist.result.transactions.some((t) => t.txid === job.txids[0]));
  await again.call('/api/lists', { lists: [{ id: 'l1', name: 'Team', rows: [] }] });
  assert.equal((await createBackend().call('/api/lists')).result.lists.length, 1);

  resetDemo();
  assert.equal(data.size, 0);
  assert.equal((await createBackend().call('/api/status')).result.wallet.exists, false);
});

test('answers are copies: changing one does not change the wallet', async () => {
  resetDemo();
  const api = createBackend();
  await api.call('/api/lists', { contacts: [{ id: 'c1', name: 'Ana' }] });
  const r = await api.call('/api/lists');
  r.result.contacts.push({ id: 'c2' });
  assert.equal((await api.call('/api/lists')).result.contacts.length, 1);
  resetDemo();
});
