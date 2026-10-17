// Bech32 (BIP 173) and Bech32m (BIP 350) without the 90-character limit.
// Zcash Unified Addresses are far longer than 90 characters (ZIP 316), so a stock
// Bitcoin bech32 decoder rejects them.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
export const BECH32 = 1;
export const BECH32M = 0x2bc830a3;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/**
 * Decode a bech32 / bech32m string.
 * @param {string} str
 * @returns {{ok: true, hrp: string, data: number[], variant: 'bech32' | 'bech32m'} | {ok: false, code: string, message: string}}
 */
export function bech32Decode(str) {
  if (typeof str !== 'string' || str.length < 8) return fail('too_short', 'Too short to be an address');
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) {
    return fail('mixed_case', 'Mixed upper and lower case letters');
  }
  const s = str.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1) return fail('no_separator', 'Missing the "1" separator');
  if (s.length - pos - 1 < 6) return fail('too_short', 'Too short to hold a checksum');
  const hrp = s.slice(0, pos);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) return fail('bad_hrp', 'Invalid prefix characters');
  }
  const data = [];
  for (const ch of s.slice(pos + 1)) {
    const idx = CHARSET.indexOf(ch);
    if (idx === -1) return fail('bad_char', `Invalid character "${ch}"`);
    data.push(idx);
  }
  const check = polymod([...hrpExpand(hrp), ...data]);
  let variant;
  if (check === BECH32) variant = 'bech32';
  else if (check === BECH32M) variant = 'bech32m';
  else return fail('bad_checksum', 'Checksum does not match, so a character is wrong or missing');
  return { ok: true, hrp, data: data.slice(0, -6), variant };
}

/**
 * Encode to bech32 or bech32m.
 * @param {string} hrp
 * @param {number[]} data 5-bit values
 * @param {'bech32' | 'bech32m'} variant
 */
export function bech32Encode(hrp, data, variant) {
  const constant = variant === 'bech32m' ? BECH32M : BECH32;
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ constant;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`;
}

/**
 * Regroup bits. With pad=false (decoding), leftover bits must be fewer than `from` and all zero.
 * @param {ArrayLike<number>} data
 * @param {number} from
 * @param {number} to
 * @param {boolean} pad
 * @returns {number[] | null}
 */
export function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

function fail(code, message) {
  return { ok: false, code, message };
}
