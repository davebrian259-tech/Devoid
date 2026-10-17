// BLAKE2b (RFC 7693) with variable output length and a 16-byte personalization string.
//
// Node's built-in `blake2b512` supports neither, and F4Jumble (ZIP 316, used by every Unified
// Address) needs both. BigInt keeps this short and obviously correct; inputs here are at most a few
// hundred bytes, so speed does not matter. Verified against RFC 7693 vectors and, for the
// personalized variable-length form, against the official F4Jumble test vectors.

const MASK = (1n << 64n) - 1n;

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & MASK;

function mix(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) & MASK;
  v[d] = rotr(v[d] ^ v[a], 32n);
  v[c] = (v[c] + v[d]) & MASK;
  v[b] = rotr(v[b] ^ v[c], 24n);
  v[a] = (v[a] + v[b] + y) & MASK;
  v[d] = rotr(v[d] ^ v[a], 16n);
  v[c] = (v[c] + v[d]) & MASK;
  v[b] = rotr(v[b] ^ v[c], 63n);
}

function readU64(bytes, offset) {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(bytes[offset + i] ?? 0);
  return x;
}

function compress(h, block, t, last) {
  const m = new Array(16);
  for (let i = 0; i < 16; i++) m[i] = readU64(block, i * 8);
  const v = [...h, ...IV];
  v[12] ^= t & MASK;
  v[13] ^= (t >> 64n) & MASK;
  if (last) v[14] ^= MASK;
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10];
    mix(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
    mix(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
    mix(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
    mix(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
    mix(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
    mix(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
    mix(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
    mix(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/**
 * @param {Uint8Array | Buffer} input
 * @param {number} [outLen] 1..64 bytes
 * @param {Uint8Array | Buffer} [personal] at most 16 bytes
 * @returns {Uint8Array}
 */
export function blake2b(input, outLen = 64, personal = new Uint8Array(0)) {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new RangeError('BLAKE2b output length must be 1..64');
  if (personal.length > 16) throw new RangeError('BLAKE2b personalization must be at most 16 bytes');

  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLen); // fanout=1, depth=1, no key
  const pers = new Uint8Array(16);
  pers.set(personal);
  h[6] ^= readU64(pers, 0);
  h[7] ^= readU64(pers, 8);

  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  let offset = 0;
  let t = 0n;
  while (data.length - offset > 128) {
    t += 128n;
    compress(h, data.subarray(offset, offset + 128), t, false);
    offset += 128;
  }
  const rest = data.subarray(offset);
  const block = new Uint8Array(128);
  block.set(rest);
  t += BigInt(rest.length);
  compress(h, block, t, true);

  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    let x = h[i];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(x & 0xffn);
      x >>= 8n;
    }
  }
  return out.slice(0, outLen);
}
