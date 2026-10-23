import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, pickEngine, chunkRecipients, validateBatch } from '../server/index.mjs';

const PASS = 'correct horse battery';
const keysOf = (v) => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);
async function boot() {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'devoid-')), engine: pickEngine({ forceMock: true }) });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, body = {}, headers = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}`, ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { app, base, call };
}

test('chunking', () => {
  assert.deepEqual(chunkRecipients(Array.from({ length: 51 }, (_, i) => i)).map((c) => c.length), [25, 25, 1]);
});

test('auth, host and origin checks', async () => {
  const { app, base } = await boot();
  const noTok = await fetch(base + '/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await noTok.text();
  assert.equal(noTok.status, 401);
  const raw = (headers) => new Promise((res, rej) => {
    const q = http.request(base + '/api/status', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}`, ...headers } }, (r) => { r.resume(); res(r.statusCode); });
    q.on('error', rej); q.end('{}');
  });
  assert.equal(await raw({ host: 'evil.example' }), 403);
  assert.equal(await raw({ origin: 'http://evil.example' }), 403);
  const get = await fetch(base + '/api/status');
  await get.text();
  assert.equal(get.status, 405);
  const csp = await fetch(base + '/');
  await csp.text();
  assert.match(csp.headers.get('content-security-policy'), /default-src 'none'/);
  await app.close();
});

test('wallet lifecycle, validation, batch send over several transactions', async () => {
  const { app, call } = await boot();
  let s = await call('/api/status');
  assert.equal(s.body.result.simulated, true);
  assert.equal(s.body.result.wallet.exists, false);
  const c = await call('/api/engine/create', { passphrase: PASS, network: 'main' });
  assert.equal(c.body.ok, true);
  assert.equal(c.body.result.phrase.split(' ').length, 24);
  const weak = await call('/api/engine/revealPhrase', { passphrase: 'nope-nope-nope' });
  assert.equal(weak.body.error.code, 'wrong_passphrase');

  const addr = c.body.result.addresses;
  const text = `address,amount,memo\n${addr.shielded},0.01,hello\n${addr.sapling},0.02,\nnotanaddress,1,\n`;
  const v = await call('/api/batch/validate', { text });
  assert.equal(v.body.result.valid, 2);
  assert.equal(v.body.result.invalid, 1);

  // 30 recipients -> two transactions (25 + 5)
  const recipients = Array.from({ length: 30 }, () => ({ address: addr.shielded, amountZat: 1_000_000 }));
  const plan = await call('/api/batch/plan', { recipients, fundingPools: ['ironwood'] });
  assert.equal(plan.body.result.transactions, 2);
  assert.equal(plan.body.result.first.recipientCount, 25);

  const noPass = await call('/api/batch/send', { recipients, fundingPools: ['ironwood'], passphrase: 'wrong-passphrase' });
  assert.equal(noPass.body.error.code, 'wrong_passphrase');

  const sent = await call('/api/batch/send', { recipients, fundingPools: ['ironwood'], passphrase: PASS });
  assert.equal(sent.body.ok, true);
  let job;
  for (let i = 0; i < 120; i++) {
    job = (await call('/api/batch/job', { jobId: sent.body.result.jobId })).body.result;
    if (job.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.equal(job.txids.length, 2);
  const h = await call('/api/engine/history', { limit: 10 });
  assert.equal(h.body.result.transactions.filter((t) => t.kind === 'sent').length, 2);
  await app.close();
});

test('transparent recipient needs acknowledgement', async () => {
  const { app, call } = await boot();
  const c = await call('/api/engine/create', { passphrase: PASS, network: 'main' });
  const recipients = [{ address: c.body.result.addresses.transparent, amountZat: 1_000_000 }];
  const r = await call('/api/batch/send', { recipients, fundingPools: ['ironwood'], passphrase: PASS });
  assert.equal(r.body.error.code, 'acknowledgement_required');
  await app.close();
});

test('validateBatch rejects wrong network', () => {
  const r = validateBatch('t1LdYqZLwhFBoXrSxLZKLAhhJ2zL2PMzXLT 1', 'test');
  assert.equal(r.ok, true);
  assert.equal(r.invalid, 1);
});

test('a real engine that fails its self-test is rejected; simulated is flagged', async () => {
  const { verifyEngine } = await import('../server/index.mjs');
  const bad = await verifyEngine({ simulated: false, cmd: process.execPath, args: [new URL('./fixtures/failing-engine.mjs', import.meta.url).pathname] });
  assert.equal(bad.ok, false);
  const missing = await verifyEngine({ simulated: false, cmd: '/nonexistent/devoid-engine', args: [] });
  assert.equal(missing.ok, false);
  const { app, call } = await boot();
  const s = await call('/api/status');
  assert.equal(s.body.result.simulated, true);
  assert.equal(s.body.result.engineVerified, false);
  await app.close();
});

test('a wrong passphrase is rejected before sending, and no phrase is handed back', async () => {
  const { app, call } = await boot();
  try {
    const c = await call('/api/engine/create', { passphrase: PASS, network: 'main' });
    assert.equal(c.body.ok, true);
    const phrase = c.body.result.phrase;
    const to = c.body.result.addresses.shielded;

    const v = await call('/api/engine/verifyPassphrase', { passphrase: PASS });
    assert.equal(v.body.ok, true);
    assert.equal(v.body.result.verified, true);
    assert.equal(v.body.result.phrase, undefined);

    const bad = await call('/api/engine/verifyPassphrase', { passphrase: 'not the one' });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.error.code, 'wrong_passphrase');

    // The server checks the passphrase before it starts sending, and the check never carries the
    // recovery phrase back out of the engine.
    const send = await call('/api/batch/send', { recipients: [{ address: to, amountZat: '100000' }], fundingPools: ['ironwood'], passphrase: 'not the one' });
    assert.equal(send.body.ok, false);
    assert.equal(send.body.error.code, 'wrong_passphrase');
    assert.ok(!JSON.stringify(send.body).includes(phrase));
    assert.deepEqual(keysOf(send.body).filter((k) => /phrase/i.test(k)), []);
  } finally {
    await app.close();
  }
});

test('the desktop key survives restarts, readable only by its owner', async () => {
  const { keptToken } = await import('../server/index.mjs');
  const { mkdtempSync, statSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'devoid-token-'));
  const first = keptToken(dir);
  assert.match(first, /^[\w-]{32}$/);
  assert.equal(keptToken(dir), first, 'the same key after a restart');
  assert.equal(statSync(join(dir, 'token')).mode & 0o777, 0o600);
  writeFileSync(join(dir, 'token'), 'short\n'); // a damaged file is replaced, not trusted
  assert.notEqual(keptToken(dir), 'short');
});
