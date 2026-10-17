// F4Jumble and its inverse (ZIP 316). A four-round Feistel construction over BLAKE2b that makes
// every bit of a Unified Address depend on every other bit, so a typo anywhere breaks the whole
// address instead of just one receiver. Verified against the official zcash-test-vectors.
import { blake2b } from './blake2b.mjs';

const MIN_LEN = 48;
const MAX_LEN = 4_194_368;
const enc = new TextEncoder();

const persH = (i) => Uint8Array.from([...enc.encode('UA_F4Jumble_H'), i, 0, 0]);
const persG = (i, j) => Uint8Array.from([...enc.encode('UA_F4Jumble_G'), i, j & 0xff, j >> 8]);

function h(i, u, outLen) {
  return blake2b(u, outLen, persH(i));
}

function g(i, u, outLen) {
  const out = new Uint8Array(outLen);
  const blocks = Math.ceil(outLen / 64);
  for (let j = 0; j < blocks; j++) {
    const block = blake2b(u, 64, persG(i, j));
    out.set(block.subarray(0, Math.min(64, outLen - j * 64)), j * 64);
  }
  return out;
}

function xor(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

// The left half is capped at one BLAKE2b output (64 bytes), as in librustzcash's `State::new`
// (`min(OUTBYTES, len / 2)`). 48 is the minimum message length, not this cap.
const MAX_LEFT = 64;

function split(m) {
  const lenL = Math.min(MAX_LEFT, Math.floor(m.length / 2));
  return [m.subarray(0, lenL), m.subarray(lenL), lenL, m.length - lenL];
}

function checkLen(m) {
  if (m.length < MIN_LEN || m.length > MAX_LEN) throw new RangeError('F4Jumble input length out of range');
}

/** @param {Uint8Array} message */
export function f4jumble(message) {
  checkLen(message);
  const [a, b, lenL, lenR] = split(message);
  const x = xor(b, g(0, a, lenR));
  const y = xor(a, h(0, x, lenL));
  const d = xor(x, g(1, y, lenR));
  const c = xor(y, h(1, d, lenL));
  return Uint8Array.from([...c, ...d]);
}

/** @param {Uint8Array} message */
export function f4jumbleInv(message) {
  checkLen(message);
  const [c, d, lenL, lenR] = split(message);
  const y = xor(c, h(1, d, lenL));
  const x = xor(d, g(1, y, lenR));
  const a = xor(y, h(0, x, lenL));
  const b = xor(x, g(0, a, lenR));
  return Uint8Array.from([...a, ...b]);
}
