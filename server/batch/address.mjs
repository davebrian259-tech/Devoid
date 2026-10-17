// Structural validation of Zcash addresses: transparent (Base58Check), Sapling (Bech32),
// Unified (Bech32m + F4Jumble, ZIP 316) and TEX (ZIP 320).
//
// This is fast, local feedback while a batch is being composed. It checks encoding, checksums,
// network and receiver layout using the same rules as librustzcash's `zcash_address` crate. It
// does NOT check that a Sapling/Orchard receiver is a valid curve point; the engine does that with
// the official parser before anything is built, and its answer always wins.
import { bech32Decode, bech32Encode, convertBits } from './bech32.mjs';
import { base58CheckDecode } from './base58.mjs';
import { f4jumble, f4jumbleInv } from './f4jumble.mjs';

const enc = new TextEncoder();

/** Largest value ZIP 316 allows for a CompactSize typecode or length (zcash_encoding MAX_COMPACT_SIZE). */
const MAX_COMPACT_SIZE = 0x02000000;
const PADDING_LEN = 16;

const UA_HRP = { u: 'main', utest: 'test', uregtest: 'regtest' };
const SAPLING_HRP = { zs: 'main', ztestsapling: 'test', zregtestsapling: 'regtest' };
const TEX_HRP = { tex: 'main', textest: 'test', texregtest: 'regtest' };
const T_PREFIX = {
  '1cb8': { network: 'main', type: 'p2pkh' },
  '1cbd': { network: 'main', type: 'p2sh' },
  '1d25': { network: 'test', type: 'p2pkh' },
  '1cba': { network: 'test', type: 'p2sh' },
};
const SPROUT_PREFIX = new Set(['169a', '16b6']);

/**
 * @typedef {'unified' | 'sapling' | 'transparent' | 'tex'} AddressKind
 * @typedef {{
 *   ok: true,
 *   kind: AddressKind,
 *   network: 'main' | 'test' | 'regtest',
 *   receivers: string[],
 *   unknownReceivers: number[],
 *   canReceiveMemo: boolean,
 *   address: string, // canonical form: lowercase for Bech32-family addresses
 * }} AddressInfo
 * @typedef {{ok: false, code: string, message: string, redact?: boolean}} AddressError
 */

/**
 * @param {unknown} input
 * @returns {AddressInfo | AddressError}
 */
export function parseAddress(input) {
  if (typeof input !== 'string') return fail('empty', 'No address given');
  const s = input.trim();
  if (s === '') return fail('empty', 'No address given');
  if (/\s/.test(s)) return fail('whitespace', 'Address contains a space or line break');
  if (/[^\x21-\x7e]/.test(s)) {
    return fail('non_ascii', 'Address contains hidden or look-alike characters. Copy it again from the source');
  }

  const lower = s.toLowerCase();
  // Secrets first, so they are never echoed back or treated as ordinary bad input.
  if (lower.startsWith('secret-extended-key') || /^zxprv/.test(lower)) {
    return fail('secret_key', 'This is a secret spending key, not an address. Never paste it anywhere', true);
  }
  if (/^(uview|uivk|zxview|zivk)/.test(lower)) {
    return fail('viewing_key', 'This is a viewing key, not an address. It cannot receive funds');
  }
  if (lower.startsWith('zcash:')) {
    return fail('payment_uri', 'This is a payment link. Use "Import payment link" for those');
  }

  const bech = bech32Decode(s);
  if (bech.ok) {
    if (bech.hrp in UA_HRP) return parseUnified(s, bech);
    if (bech.hrp in SAPLING_HRP) return parseSapling(s, bech);
    if (bech.hrp in TEX_HRP) return parseTex(s, bech);
    return fail('unknown_format', `Unrecognised address prefix "${bech.hrp.slice(0, 20)}"`);
  }
  if (/^(u1|utest1|uregtest1|zs1|ztestsapling1|zregtestsapling1|tex1|textest1)/.test(lower)) {
    return fail(bech.code === 'bad_checksum' ? 'bad_checksum' : 'bad_encoding', bech.message);
  }

  const b58 = base58CheckDecode(s);
  if (!b58.ok) {
    if (/^(t|zc|zt)/.test(s)) return fail(b58.code === 'bad_checksum' ? 'bad_checksum' : 'bad_encoding', b58.message);
    return fail('unknown_format', 'Not a recognised Zcash address');
  }
  return parseBase58Payload(s, b58.payload);
}

function parseBase58Payload(s, payload) {
  const prefix = Buffer.from(payload.subarray(0, 2)).toString('hex');
  if (payload.length === 22 && T_PREFIX[prefix]) {
    const { network, type } = T_PREFIX[prefix];
    return { ok: true, kind: 'transparent', network, receivers: [type], unknownReceivers: [], canReceiveMemo: false, address: s };
  }
  if (payload.length === 66 && SPROUT_PREFIX.has(prefix)) {
    return fail('sprout', 'Sprout addresses are retired and cannot be paid. Ask for a unified (u1…) address');
  }
  if ((payload.length === 33 || payload.length === 34) && (payload[0] === 0x80 || payload[0] === 0xef)) {
    return fail('secret_key', 'This is a secret private key, not an address. Never paste it anywhere', true);
  }
  return fail('unknown_format', 'Not a recognised Zcash address');
}

function parseSapling(s, bech) {
  if (bech.variant !== 'bech32') return fail('bad_checksum', 'Sapling addresses use the Bech32 checksum, this one does not');
  const bytes = convertBits(bech.data, 5, 8, false);
  if (!bytes || bytes.length !== 43) return fail('bad_length', 'Sapling address has the wrong length');
  return {
    ok: true,
    kind: 'sapling',
    network: SAPLING_HRP[bech.hrp],
    receivers: ['sapling'],
    unknownReceivers: [],
    canReceiveMemo: true,
    address: s.toLowerCase(),
  };
}

function parseTex(s, bech) {
  if (bech.variant !== 'bech32m') return fail('bad_checksum', 'TEX addresses use the Bech32m checksum, this one does not');
  const bytes = convertBits(bech.data, 5, 8, false);
  if (!bytes || bytes.length !== 20) return fail('bad_length', 'TEX address has the wrong length');
  return {
    ok: true,
    kind: 'tex',
    network: TEX_HRP[bech.hrp],
    receivers: ['p2pkh'],
    unknownReceivers: [],
    canReceiveMemo: false,
    address: s.toLowerCase(),
  };
}

function parseUnified(s, bech) {
  if (bech.variant !== 'bech32m') return fail('bad_checksum', 'Unified addresses use the Bech32m checksum, this one does not');
  const bytes = convertBits(bech.data, 5, 8, false);
  if (!bytes) return fail('bad_encoding', 'Address has invalid padding bits');
  if (bytes.length < 48) return fail('ua_too_short', 'Too short to be a unified address');
  const items = decodeUnifiedItems(bech.hrp, Uint8Array.from(bytes));
  if (!items.ok) return items;

  const receivers = [];
  const unknownReceivers = [];
  for (const it of items.items) {
    if (it.name === 'unknown') unknownReceivers.push(it.typecode);
    else receivers.push(it.name);
  }
  return {
    ok: true,
    kind: 'unified',
    network: UA_HRP[bech.hrp],
    receivers,
    unknownReceivers,
    canReceiveMemo: receivers.includes('sapling') || receivers.includes('orchard'),
    address: s.toLowerCase(),
  };
}

const RECEIVER_BY_TYPECODE = { 0: ['p2pkh', 20], 1: ['p2sh', 20], 2: ['sapling', 43], 3: ['orchard', 43] };

/**
 * Un-jumble and parse the receivers of a Unified Address. Mirrors `parse_items` and
 * `try_from_items_internal` in librustzcash's zcash_address crate.
 * @param {string} hrp
 * @param {Uint8Array} jumbled
 * @returns {{ok: true, items: {typecode: number, name: string, data: Uint8Array}[]} | AddressError}
 */
function decodeUnifiedItems(hrp, jumbled) {
  const plain = f4jumbleInv(jumbled);
  const expectedPad = new Uint8Array(PADDING_LEN);
  expectedPad.set(enc.encode(hrp));
  const body = plain.subarray(0, plain.length - PADDING_LEN);
  const tail = plain.subarray(plain.length - PADDING_LEN);
  if (!tail.every((b, i) => b === expectedPad[i])) {
    return fail('ua_padding', 'Not a valid unified address (it is corrupted, or for another network)');
  }

  const items = [];
  let pos = 0;
  while (pos < body.length) {
    const code = readCompactSize(body, pos);
    if (!code) return fail('ua_encoding', 'Unified address is malformed (bad typecode)');
    pos = code.next;
    const len = readCompactSize(body, pos);
    if (!len) return fail('ua_encoding', 'Unified address is malformed (bad length)');
    pos = len.next;
    if (pos + len.value > body.length) return fail('ua_encoding', 'Unified address is truncated');
    const data = body.subarray(pos, pos + len.value);
    pos += len.value;

    const known = RECEIVER_BY_TYPECODE[code.value];
    if (known) {
      if (data.length !== known[1]) return fail('ua_encoding', `Unified address has an invalid ${known[0]} receiver`);
      items.push({ typecode: code.value, name: known[0], data });
    } else {
      items.push({ typecode: code.value, name: 'unknown', data });
    }
  }

  let prev = -1;
  let onlyTransparent = true;
  for (const it of items) {
    if (it.typecode < prev) return fail('ua_order', 'Unified address receivers are out of order');
    if (it.typecode === prev) return fail('ua_duplicate', 'Unified address repeats a receiver');
    if (it.typecode === 1 && prev === 0) return fail('ua_both_transparent', 'Unified address has two transparent receivers');
    prev = it.typecode;
    onlyTransparent = onlyTransparent && (it.typecode === 0 || it.typecode === 1);
  }
  if (items.length === 0 || onlyTransparent) {
    return fail('ua_only_transparent', 'Unified address has no shielded receiver');
  }
  return { ok: true, items };
}

/** Canonical CompactSize read; returns null for truncated, non-canonical or oversized values. */
function readCompactSize(buf, pos) {
  if (pos >= buf.length) return null;
  const flag = buf[pos];
  let value;
  let next;
  if (flag < 253) {
    value = flag;
    next = pos + 1;
  } else if (flag === 253) {
    if (pos + 3 > buf.length) return null;
    value = buf[pos + 1] | (buf[pos + 2] << 8);
    if (value < 253) return null;
    next = pos + 3;
  } else if (flag === 254) {
    if (pos + 5 > buf.length) return null;
    value = (buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16) | (buf[pos + 4] << 24)) >>> 0;
    if (value < 0x10000) return null;
    next = pos + 5;
  } else {
    return null; // 8-byte form is always above MAX_COMPACT_SIZE
  }
  if (value > MAX_COMPACT_SIZE) return null;
  return { value, next };
}

function writeCompactSize(n) {
  if (n < 253) return [n];
  if (n <= 0xffff) return [253, n & 0xff, n >> 8];
  return [254, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

/**
 * Build a Unified Address from raw receivers. Used by tests (round trips against the official
 * vectors) and by the simulated engine. Receivers must be in ascending typecode order.
 * @param {'main' | 'test' | 'regtest'} network
 * @param {{typecode: number, data: Uint8Array}[]} receivers
 */
export function encodeUnified(network, receivers) {
  const hrp = Object.keys(UA_HRP).find((k) => UA_HRP[k] === network);
  const out = [];
  for (const r of receivers) out.push(...writeCompactSize(r.typecode), ...writeCompactSize(r.data.length), ...r.data);
  const pad = new Uint8Array(PADDING_LEN);
  pad.set(enc.encode(hrp));
  const jumbled = f4jumble(Uint8Array.from([...out, ...pad]));
  return bech32Encode(hrp, convertBits(jumbled, 8, 5, true), 'bech32m');
}

/**
 * Pool a payment to this address lands in, assuming the sender's wallet picks the best receiver
 * (Orchard-type, then Sapling, then transparent) as librustzcash does. Orchard-type receivers
 * land in Ironwood once NU6.3 is active.
 * @param {AddressInfo} info
 * @param {boolean} ironwoodIsActive
 * @returns {'ironwood' | 'orchard' | 'sapling' | 'transparent' | null}
 */
export function destinationPool(info, ironwoodIsActive) {
  if (info.receivers.includes('orchard')) return ironwoodIsActive ? 'ironwood' : 'orchard';
  if (info.receivers.includes('sapling')) return 'sapling';
  if (info.receivers.includes('p2pkh') || info.receivers.includes('p2sh')) return 'transparent';
  return null;
}

/** Plain-language names for UI and reports. */
export const POOL_LABEL = Object.freeze({
  ironwood: 'Ironwood (shielded)',
  orchard: 'Orchard (shielded)',
  sapling: 'Sapling (shielded)',
  transparent: 'Transparent (public)',
});

function fail(code, message, redact = false) {
  return redact ? { ok: false, code, message, redact: true } : { ok: false, code, message };
}
