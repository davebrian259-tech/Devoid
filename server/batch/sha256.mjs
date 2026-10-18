// SHA-256 (FIPS 180-4) in plain JavaScript, so the address parsers run the same in Node and in a
// browser. Used for Base58Check checksums and by the simulated engine; never for real keys.

const first = (n) => { const out = []; for (let c = 2; out.length < n; c++) if (out.every((p) => c % p)) out.push(c); return out; };
const frac32 = (x) => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0;
// The constants are defined as the first 32 bits of the fractional parts of the square roots of
// the first 8 primes (H) and the cube roots of the first 64 (K); computing them avoids typos.
const PRIMES = first(64);
const H0 = Uint32Array.from(PRIMES.slice(0, 8), (p) => frac32(Math.sqrt(p)));
const K = Uint32Array.from(PRIMES, (p) => frac32(Math.cbrt(p)));

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a byte array. */
export function sha256(bytes) {
  const msg = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg); padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000)); // high bits of the bit length
  view.setUint32(padded.length - 4, (len << 3) >>> 0);
  const h = H0.slice(); const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32); const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const utf8 = (s) => new TextEncoder().encode(String(s));
export const utf8Length = (s) => utf8(s).length;
/** SHA-256 of a string, as hex. */
export const sha256Hex = (s) => toHex(sha256(utf8(s)));
