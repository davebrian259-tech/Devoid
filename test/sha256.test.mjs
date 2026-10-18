import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256, sha256Hex, toHex, utf8 } from '../server/batch/sha256.mjs';

test('SHA-256 matches the FIPS 180-4 test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256Hex('a'.repeat(1_000_000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('SHA-256 agrees with node:crypto at every padding boundary and on random input', () => {
  const node = (b) => createHash('sha256').update(b).digest('hex');
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
    const b = randomBytes(n);
    assert.equal(toHex(sha256(b)), node(b), `length ${n}`);
  }
  for (let i = 0; i < 50; i++) { const b = randomBytes(1 + (i * 37) % 700); assert.equal(toHex(sha256(b)), node(b)); }
  assert.equal(toHex(sha256(utf8('héllo ✨'))), node(Buffer.from('héllo ✨')));
});
