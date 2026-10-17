// Base58Check, as used by Zcash transparent (t-) addresses.
import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const sha256 = (b) => createHash('sha256').update(b).digest();

/**
 * @param {string} str
 * @returns {{ok: true, payload: Uint8Array} | {ok: false, code: string, message: string}}
 */
export function base58CheckDecode(str) {
  if (typeof str !== 'string' || str.length === 0) return fail('empty', 'Empty');
  let n = 0n;
  for (const ch of str) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) return fail('bad_char', `Invalid character "${ch}"`);
    n = n * 58n + BigInt(idx);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const full = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) full[full.length - 1 - i] = bytes[i];
  if (full.length < 5) return fail('too_short', 'Too short');
  const body = full.subarray(0, full.length - 4);
  const check = full.subarray(full.length - 4);
  const expect = sha256(sha256(body)).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (check[i] !== expect[i]) return fail('bad_checksum', 'Checksum does not match, so a character is wrong or missing');
  }
  return { ok: true, payload: body };
}

/**
 * @param {Uint8Array} payload
 */
export function base58CheckEncode(payload) {
  const check = sha256(sha256(payload)).subarray(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(check, payload.length);
  let n = 0n;
  for (const b of full) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of full) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function fail(code, message) {
  return { ok: false, code, message };
}
