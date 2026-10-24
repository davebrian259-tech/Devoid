// The passkey wrap: what a device's secret (the WebAuthn PRF output) protects, and what it must
// refuse. The WebAuthn calls themselves are a browser's to make; what is tested here is everything
// that happens to the passphrase around them. The browser tests drive the rest with a virtual
// authenticator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealUnder, openUnder } from '../ui/local/passkey.js';

const secret = () => crypto.getRandomValues(new Uint8Array(32));
const where = { id: 'Y3JlZA==', label: 'This browser' };
const PASS = 'correct horse battery staple';

test('the passphrase comes back from the device secret that sealed it', async () => {
  const s = secret();
  const record = await sealUnder(s, PASS, where);
  assert.equal(record.format, 'devoid-passkey');
  assert.equal(record.version, 1);
  assert.equal(record.id, where.id);
  assert.equal(await openUnder(s, record), PASS);
});

test('the sealed passphrase is nowhere in the record', async () => {
  const record = await sealUnder(secret(), PASS, where);
  assert.ok(!JSON.stringify(record).includes(PASS));
  assert.ok(!JSON.stringify(record).toLowerCase().includes('correct'));
});

test('another device secret does not open it', async () => {
  const record = await sealUnder(secret(), PASS, where);
  await assert.rejects(() => openUnder(secret(), record), (e) => e.code === 'wrong_passkey');
});

test('a record changed after the fact does not open', async () => {
  const s = secret();
  const record = await sealUnder(s, PASS, where);
  const flipped = { ...record, data: `${record.data.slice(0, -4)}AAA=` };
  await assert.rejects(() => openUnder(s, flipped), (e) => e.code === 'wrong_passkey');
  await assert.rejects(() => openUnder(s, { ...record, kdf: { ...record.kdf, salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') } }), (e) => e.code === 'wrong_passkey');
});

test('anything that is not a passkey record is refused as damaged', async () => {
  const s = secret();
  for (const bad of [null, {}, { format: 'devoid-passkey', version: 2 }, { format: 'other', version: 1, kdf: { salt: 'x' }, cipher: { iv: 'y' }, data: 'z' }]) {
    await assert.rejects(() => openUnder(s, bad), (e) => e.code === 'damaged');
  }
});

test('each sealing is its own: new salt, new nonce, different bytes', async () => {
  const s = secret();
  const a = await sealUnder(s, PASS, where);
  const b = await sealUnder(s, PASS, where);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.cipher.iv, b.cipher.iv);
  assert.notEqual(a.data, b.data);
  assert.equal(await openUnder(s, b), PASS);
});
