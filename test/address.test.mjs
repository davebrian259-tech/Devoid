// Address validation, checked against Zcash's own test data (librustzcash components and
// zcash_keys vectors, regenerated with scripts/gen-vectors.mjs) rather than against itself.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { blake2b } from '../server/batch/blake2b.mjs';
import { f4jumble, f4jumbleInv } from '../server/batch/f4jumble.mjs';
import { bech32Decode, bech32Encode, convertBits } from '../server/batch/bech32.mjs';
import { base58CheckDecode, base58CheckEncode } from '../server/batch/base58.mjs';
import { parseAddress, encodeUnified, destinationPool } from '../server/batch/address.mjs';
import { ironwoodActive, estimateHeightForDate, NETWORKS } from '../server/batch/network.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, 'fixtures', 'zcash-vectors.json'), 'utf8'));

const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (b) => Buffer.from(b).toString('hex');
const enc = new TextEncoder();
const seq = (n, mul = 1) => Uint8Array.from({ length: n }, (_, i) => (i * mul) & 0xff);

/** Assemble a UA from raw bytes, bypassing the structural checks in encodeUnified. */
function rawUnified(hrp, body, padHrp = hrp) {
  const pad = new Uint8Array(16);
  pad.set(enc.encode(padHrp));
  const jumbled = f4jumble(Uint8Array.from([...body, ...pad]));
  return bech32Encode(hrp, convertBits(jumbled, 8, 5, true), 'bech32m');
}
const compact = (n) => (n < 253 ? [n] : [253, n & 0xff, n >> 8]);
const item = (typecode, data) => [...compact(typecode), ...compact(data.length), ...data];

describe('blake2b', () => {
  test('RFC 7693 appendix A: BLAKE2b-512("abc")', () => {
    assert.equal(
      toHex(blake2b(enc.encode('abc'))),
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    );
  });

  test('matches node:crypto blake2b512 across block boundaries', () => {
    for (const len of [0, 1, 2, 63, 64, 65, 127, 128, 129, 200, 256, 257, 1000]) {
      const input = seq(len, 7);
      const expected = createHash('blake2b512').update(input).digest('hex');
      assert.equal(toHex(blake2b(input)), expected, `length ${len}`);
    }
  });

  // Independent vectors from Python's hashlib.blake2b (digest_size / person parameters).
  const cases = [
    { input: '', outLen: 32, personal: '', out: '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8' },
    { input: '616263', outLen: 32, personal: '', out: 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319' },
    {
      input: '616263', outLen: 48, personal: '55415f46344a756d626c655f48000000',
      out: '933109cc8a622c17a40367c2b00a21c24a889b83bfb2675311b2b817279aadd89d9693048f7fe8032e4d306cd5faed3d',
    },
    {
      input: '616263', outLen: 64, personal: '55415f46344a756d626c655f47010200',
      out: '5f8afa1eb39e3a948407de36452310a60ae938d589fbd3aa62e069bbb0d196445d39f106fa31dad25e85e8fa1c6a989bb2f52a7977bac1257db61c998d2d4b2b',
    },
    {
      input: toHex(seq(200)), outLen: 37, personal: '5a63617368507265766f757448617368',
      out: '6e192caa4c92870854f6ec2f5bdf743a00f72ffe5a2b2bfe3b4c0c0d42d3394d0743ff280c',
    },
    {
      input: toHex(Uint8Array.from({ length: 768 }, (_, i) => i & 0xff)), outLen: 64, personal: '706572736f6e616c697a6174696f6e',
      out: '8c8edd170f7db9ecbed392ac6a93ba9ff80dc8339b7c483cac5eb6171508246ebc428ab8b122eccc8808c889fffd4aef5c9873388123a0a5d63b51b53f0382aa',
    },
  ];
  for (const c of cases) {
    test(`variable length + personalization: ${c.outLen} bytes, ${c.input.length / 2} byte input`, () => {
      assert.equal(toHex(blake2b(hex(c.input), c.outLen, hex(c.personal))), c.out);
    });
  }

  test('rejects impossible parameters', () => {
    assert.throws(() => blake2b(new Uint8Array(1), 0), RangeError);
    assert.throws(() => blake2b(new Uint8Array(1), 65), RangeError);
    assert.throws(() => blake2b(new Uint8Array(1), 32, new Uint8Array(17)), RangeError);
  });
});

describe('f4jumble (ZIP 316 official vectors)', () => {
  test('fixture is present and covers the interesting split sizes', () => {
    assert.ok(V.f4jumble.length >= 6);
    const sizes = V.f4jumble.map((v) => v.normal.length / 2);
    assert.ok(sizes.includes(48));
    assert.ok(sizes.some((n) => n > 96));
  });

  for (const [i, v] of V.f4jumble.entries()) {
    const n = v.normal.length / 2;
    test(`vector ${i}: ${n} bytes forward and inverse`, () => {
      assert.equal(toHex(f4jumble(hex(v.normal))), v.jumbled);
      assert.equal(toHex(f4jumbleInv(hex(v.jumbled))), v.normal);
    });
  }

  test('round trips and changes every region of the message', () => {
    for (const len of [48, 49, 95, 96, 97, 130, 300]) {
      const m = seq(len, 13);
      const j = f4jumble(m);
      assert.notDeepEqual(j, m);
      assert.deepEqual(f4jumbleInv(j), m);
      // Flipping one bit anywhere changes the output at both ends (the point of F4Jumble).
      const t = Uint8Array.from(m);
      t[len - 1] ^= 1;
      const j2 = f4jumble(t);
      assert.notEqual(j2[0], j[0]);
      assert.notEqual(j2[len - 1], j[len - 1]);
    }
  });

  test('rejects lengths outside 48..4194368', () => {
    assert.throws(() => f4jumble(new Uint8Array(47)), RangeError);
    assert.throws(() => f4jumbleInv(new Uint8Array(47)), RangeError);
    assert.throws(() => f4jumble(new Uint8Array(4_194_369)), RangeError);
  });
});

describe('bech32 / bech32m', () => {
  const bech32Valid = [
    'A12UEL5L',
    'a12uel5l',
    'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
    'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w',
    '?1ezyfcl',
  ];
  const bech32mValid = [
    'A1LQFN3A',
    'a1lqfn3a',
    'abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx',
    'split1checkupstagehandshakeupstreamerranterredcaperredlc445v',
    '?1v759aa',
  ];

  test('BIP 173 valid strings decode as bech32', () => {
    for (const s of bech32Valid) {
      const r = bech32Decode(s);
      assert.equal(r.ok, true, s);
      assert.equal(r.variant, 'bech32', s);
    }
  });

  test('BIP 350 valid strings decode as bech32m', () => {
    for (const s of bech32mValid) {
      const r = bech32Decode(s);
      assert.equal(r.ok, true, s);
      assert.equal(r.variant, 'bech32m', s);
    }
  });

  test('encode is the inverse of decode', () => {
    for (const [s, variant] of [...bech32Valid.map((x) => [x, 'bech32']), ...bech32mValid.map((x) => [x, 'bech32m'])]) {
      const d = bech32Decode(s);
      assert.equal(bech32Encode(d.hrp, d.data, variant), s.toLowerCase());
    }
  });

  test('has no 90 character limit (Unified Addresses are far longer)', () => {
    const data = Array.from({ length: 400 }, (_, i) => i % 32);
    const s = bech32Encode('u', data, 'bech32m');
    assert.ok(s.length > 90);
    const d = bech32Decode(s);
    assert.equal(d.ok, true);
    assert.deepEqual(d.data, data);
  });

  test('rejects mixed case, bad characters and any single-character change', () => {
    assert.equal(bech32Decode('A12uEL5L').code, 'mixed_case');
    assert.equal(bech32Decode('a12uel5b').code, 'bad_char'); // "b" is not in the charset
    const good = 'abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx';
    for (let i = 7; i < good.length; i++) {
      const swapped = good[i] === 'q' ? 'p' : 'q';
      const bad = good.slice(0, i) + swapped + good.slice(i + 1);
      assert.equal(bech32Decode(bad).code, 'bad_checksum', `position ${i}`);
    }
    assert.equal(bech32Decode('no separator here').ok, false);
    assert.equal(bech32Decode('qqqqqqqq').code, 'no_separator');
  });

  test('convertBits enforces zero padding when decoding', () => {
    assert.deepEqual(convertBits([0b11111, 0b11100], 5, 8, false), [0xff]);
    assert.equal(convertBits([0b11111, 0b11101], 5, 8, false), null); // non-zero padding
    assert.equal(convertBits([1, 2, 3, 4, 5, 6, 7, 8, 9], 5, 8, false), null); // 5 leftover bits: a whole extra group
  });
});

describe('base58check', () => {
  test('round trips every official transparent vector', () => {
    for (const t of V.transparent) {
      const d = base58CheckDecode(t.encoding);
      assert.equal(d.ok, true, t.encoding);
      assert.equal(base58CheckEncode(d.payload), t.encoding);
    }
  });

  test('detects a changed character', () => {
    const s = 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC';
    assert.equal(base58CheckDecode(s).ok, true);
    const bad = `${s.slice(0, 10)}${s[10] === 'a' ? 'b' : 'a'}${s.slice(11)}`;
    assert.equal(base58CheckDecode(bad).code, 'bad_checksum');
    assert.equal(base58CheckDecode('t1Vmm0GiyjVNeCjxDZzg7vZmd99WyzVby9yC').code, 'bad_char'); // zero is not base58
  });
});

describe('unified addresses (60 official vectors)', () => {
  const names = ['p2pkh', 'p2sh', 'sapling', 'orchard'];
  const receiversOf = (v) => {
    const out = [];
    names.forEach((n, typecode) => {
      if (v[n]) out.push({ typecode, data: hex(v[n]) });
    });
    if (v.unknownTypecode !== null) out.push({ typecode: v.unknownTypecode, data: hex(v.unknownBytes ?? '') });
    return out;
  };

  test('fixture has the variety we rely on', () => {
    assert.equal(V.unified.length, 60);
    assert.ok(V.unified.some((v) => v.orchard && !v.sapling && !v.p2pkh), 'orchard only');
    assert.ok(V.unified.some((v) => v.sapling && v.p2pkh), 'sapling + transparent');
    assert.ok(V.unified.some((v) => v.unknownTypecode !== null), 'unknown receivers');
  });

  for (const [i, v] of V.unified.entries()) {
    test(`vector ${i}: parse and re-encode`, () => {
      const r = parseAddress(v.address);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.kind, 'unified');
      assert.equal(r.network, 'main');
      const expected = names.filter((n) => v[n]);
      assert.deepEqual(r.receivers, expected);
      assert.deepEqual(r.unknownReceivers, v.unknownTypecode === null ? [] : [v.unknownTypecode]);
      assert.equal(r.canReceiveMemo, Boolean(v.sapling || v.orchard));
      assert.equal(r.address, v.address);
      // Our encoder reproduces the official string byte for byte.
      assert.equal(encodeUnified('main', receiversOf(v)), v.address);
    });
  }

  test('upper case is accepted and canonicalised, mixed case is not', () => {
    const a = V.unified[0].address;
    const up = parseAddress(a.toUpperCase());
    assert.equal(up.ok, true);
    assert.equal(up.address, a);
    const mixed = a.slice(0, 20) + a.slice(20).toUpperCase();
    const m = parseAddress(mixed);
    assert.equal(m.ok, false);
    assert.equal(m.code, 'bad_encoding');
  });

  test('any single-character change is caught by the checksum', () => {
    const a = V.unified[3].address;
    let caught = 0;
    for (let i = 3; i < a.length; i++) {
      const bad = a.slice(0, i) + (a[i] === 'q' ? 'p' : 'q') + a.slice(i + 1);
      const r = parseAddress(bad);
      assert.equal(r.ok, false, `position ${i}`);
      assert.equal(r.code, 'bad_checksum', `position ${i}`);
      caught++;
    }
    assert.ok(caught > 100);
  });

  test('a mainnet address cannot be passed off as testnet by editing the prefix', () => {
    const a = V.unified[0].address;
    const retagged = `utest${a.slice(1)}`;
    assert.equal(parseAddress(retagged).ok, false);
  });

  test('testnet and regtest encodings of the same receivers parse with the right network', () => {
    const receivers = [
      { typecode: 2, data: hex(V.unified[0].sapling) },
      { typecode: 3, data: hex(V.unified[3].orchard) },
    ];
    const test = encodeUnified('test', receivers);
    const reg = encodeUnified('regtest', receivers);
    assert.ok(test.startsWith('utest1'));
    assert.ok(reg.startsWith('uregtest1'));
    assert.equal(parseAddress(test).network, 'test');
    assert.equal(parseAddress(reg).network, 'regtest');
  });

  describe('structural rules from ZIP 316', () => {
    const sap = seq(43, 3);
    const orc = seq(43, 5);
    const p2pkh = seq(20, 7);
    const p2sh = seq(20, 11);

    test('baseline built by hand is valid', () => {
      const a = rawUnified('u', [...item(2, sap), ...item(3, orc)]);
      const r = parseAddress(a);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.receivers, ['sapling', 'orchard']);
    });

    test('receivers out of order', () => {
      assert.equal(parseAddress(rawUnified('u', [...item(3, orc), ...item(2, sap)])).code, 'ua_order');
    });

    test('duplicate receiver', () => {
      assert.equal(parseAddress(rawUnified('u', [...item(2, sap), ...item(2, sap)])).code, 'ua_duplicate');
    });

    test('both transparent receivers', () => {
      const a = rawUnified('u', [...item(0, p2pkh), ...item(1, p2sh), ...item(3, orc)]);
      assert.equal(parseAddress(a).code, 'ua_both_transparent');
    });

    test('wrong receiver length', () => {
      assert.equal(parseAddress(rawUnified('u', [...item(2, seq(42)), ...item(3, orc)])).code, 'ua_encoding');
      assert.equal(parseAddress(rawUnified('u', [...item(0, seq(21)), ...item(3, orc)])).code, 'ua_encoding');
    });

    test('truncated body', () => {
      const body = [...item(2, sap), ...item(3, orc)];
      assert.equal(parseAddress(rawUnified('u', body.slice(0, -5))).code, 'ua_encoding');
    });

    test('non-canonical CompactSize', () => {
      // typecode 2 written in the 3-byte form
      const body = [0xfd, 0x02, 0x00, sap.length, ...sap, ...item(3, orc)];
      assert.equal(parseAddress(rawUnified('u', body)).code, 'ua_encoding');
    });

    test('padding for another network', () => {
      const a = rawUnified('u', [...item(2, sap), ...item(3, orc)], 'utest');
      assert.equal(parseAddress(a).code, 'ua_padding');
    });

    test('too short to be a unified address', () => {
      const s = bech32Encode('u', convertBits(seq(40), 8, 5, true), 'bech32m');
      assert.equal(parseAddress(s).code, 'ua_too_short');
    });

    test('wrong checksum variant', () => {
      const s = bech32Encode('u', convertBits(seq(60), 8, 5, true), 'bech32');
      assert.equal(parseAddress(s).code, 'bad_checksum');
    });

    test('only unknown receivers parses but has no usable pool', () => {
      const a = rawUnified('u', item(0xfffc, seq(40)));
      const r = parseAddress(a);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.receivers, []);
      assert.deepEqual(r.unknownReceivers, [0xfffc]);
      assert.equal(r.canReceiveMemo, false);
      assert.equal(destinationPool(r, true), null);
    });
  });
});

describe('sapling and TEX addresses', () => {
  const sapMain = 'zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9slya';
  const sapTest = 'ztestsapling1n65uaftvs2g7075q2x2a04shfk066u3lldzxsrprfrqtzxnhc9ps73v4lhx4l9yfxj46sl0q90k';
  const sapReg = 'zregtestsapling1qqqqqqqqqqqqqqqqqqcguyvaw2vjk4sdyeg0lc970u659lvhqq7t0np6hlup5lusxle7505hlz3';
  const texMain = 'tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte';
  const texTest = 'textest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpfcjgfy';

  test('sapling addresses on every network', () => {
    for (const [a, network] of [[sapMain, 'main'], [sapTest, 'test'], [sapReg, 'regtest']]) {
      const r = parseAddress(a);
      assert.equal(r.ok, true, a);
      assert.equal(r.kind, 'sapling');
      assert.equal(r.network, network);
      assert.deepEqual(r.receivers, ['sapling']);
      assert.equal(r.canReceiveMemo, true);
      assert.equal(destinationPool(r, true), 'sapling');
    }
  });

  test('sapling: wrong checksum variant, wrong length, one wrong character', () => {
    const d = bech32Decode(sapMain);
    assert.equal(parseAddress(bech32Encode('zs', d.data, 'bech32m')).code, 'bad_checksum');
    const short = convertBits(convertBits(d.data, 5, 8, false).slice(0, 42), 8, 5, true);
    assert.equal(parseAddress(bech32Encode('zs', short, 'bech32')).code, 'bad_length');
    const typo = `${sapMain.slice(0, 30)}${sapMain[30] === 'q' ? 'p' : 'q'}${sapMain.slice(31)}`;
    assert.equal(parseAddress(typo).code, 'bad_checksum');
  });

  test('TEX addresses parse as transparent-only with no memo', () => {
    for (const [a, network] of [[texMain, 'main'], [texTest, 'test']]) {
      const r = parseAddress(a);
      assert.equal(r.ok, true, a);
      assert.equal(r.kind, 'tex');
      assert.equal(r.network, network);
      assert.equal(r.canReceiveMemo, false);
      assert.equal(destinationPool(r, true), 'transparent');
    }
  });

  test('TEX and its P2PKH twin carry the same 20-byte hash (ZIP 320 example)', () => {
    const tex = bech32Decode(texMain);
    const hash = Buffer.from(convertBits(tex.data, 5, 8, false)).toString('hex');
    const p2pkh = base58CheckDecode('t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC');
    assert.equal(Buffer.from(p2pkh.payload.subarray(2)).toString('hex'), hash);
  });
});

describe('transparent addresses (official vectors)', () => {
  const pub = V.transparent.filter((t) => t.kind === 'pubkey');
  const priv = V.transparent.filter((t) => t.kind === 'privkey');

  test('fixture has both kinds on both networks', () => {
    assert.ok(pub.length >= 20);
    assert.ok(priv.length >= 20);
    assert.ok(pub.some((t) => t.network === 'main') && pub.some((t) => t.network === 'test'));
  });

  for (const t of pub) {
    test(`public ${t.network} ${t.encoding}`, () => {
      const r = parseAddress(t.encoding);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.kind, 'transparent');
      assert.equal(r.network, t.network);
      const isP2pkh = t.hex.startsWith('76a914');
      assert.deepEqual(r.receivers, [isP2pkh ? 'p2pkh' : 'p2sh']);
      assert.equal(r.canReceiveMemo, false);
      assert.equal(destinationPool(r, true), 'transparent');
      // The script in the vector contains the same 20 byte hash the address encodes.
      const hash = isP2pkh ? t.hex.slice(6, 46) : t.hex.slice(4, 44);
      assert.equal(Buffer.from(base58CheckDecode(t.encoding).payload.subarray(2)).toString('hex'), hash);
    });
  }

  for (const t of priv) {
    test(`private key ${t.network} is refused and flagged for redaction`, () => {
      const r = parseAddress(t.encoding);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'secret_key');
      assert.equal(r.redact, true);
      assert.ok(!r.message.includes(t.encoding));
    });
  }

  test('a changed character is a checksum error', () => {
    const a = pub[0].encoding;
    const bad = `${a.slice(0, 12)}${a[12] === 'x' ? 'y' : 'x'}${a.slice(13)}`;
    assert.equal(parseAddress(bad).code, 'bad_checksum');
  });
});

describe('everything that is not a payable address', () => {
  const cases = [
    ['empty string', '', 'empty'],
    ['spaces only', '   ', 'empty'],
    ['inner space', 't1VmmGiyjVNeCjxDZzg7 vZmd99WyzVby9yC', 'whitespace'],
    ['line break', 'zs1abc\ndef', 'whitespace'],
    ['zero width space', 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC​'.replace('C​', 'C​C'), 'non_ascii'],
    ['cyrillic look-alike', 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yС', 'non_ascii'],
    ['secret extended key', 'secret-extended-key-main1qqqqqqqqqqqqqq', 'secret_key'],
    ['viewing key (uview)', 'uview1qqqqqqqqqqqqqqqqqqqq', 'viewing_key'],
    ['viewing key (zxviews)', 'zxviews1qqqqqqqqqqqqqqqqqqqq', 'viewing_key'],
    ['payment uri', 'zcash:u1abcdefg?amount=1', 'payment_uri'],
    ['bitcoin address', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'unknown_format'],
    ['bitcoin bech32', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'unknown_format'],
    ['ethereum address', '0x52908400098527886E0F7030069857D2E4169EE7', 'unknown_format'],
    ['random text', 'hello world', 'whitespace'],
    ['random word', 'notanaddress', 'unknown_format'],
  ];
  for (const [name, input, code] of cases) {
    test(name, () => {
      const r = parseAddress(input);
      assert.equal(r.ok, false);
      assert.equal(r.code, code);
    });
  }

  test('secret keys are never echoed back', () => {
    const r = parseAddress('secret-extended-key-main1qqqqqqqqqqqqqq');
    assert.equal(r.redact, true);
    assert.ok(!r.message.includes('qqqq'));
  });

  test('sprout addresses are recognised and refused', () => {
    const payload = Uint8Array.from([0x16, 0x9a, ...seq(64)]);
    const sprout = base58CheckEncode(payload);
    assert.ok(sprout.startsWith('zc'));
    assert.equal(parseAddress(sprout).code, 'sprout');
  });

  test('non-string input', () => {
    for (const v of [undefined, null, 5, {}, []]) assert.equal(parseAddress(v).code, 'empty');
  });

  test('leading and trailing whitespace is trimmed', () => {
    const a = V.transparent.find((t) => t.kind === 'pubkey').encoding;
    assert.equal(parseAddress(`  ${a}\n`).ok, true);
  });
});

describe('destinationPool', () => {
  const find = (pred) => V.unified.find(pred).address;

  test('orchard receivers land in Ironwood once it is active, Orchard before', () => {
    const r = parseAddress(find((v) => v.orchard));
    assert.equal(destinationPool(r, true), 'ironwood');
    assert.equal(destinationPool(r, false), 'orchard');
  });

  test('sapling + transparent unified address uses sapling', () => {
    const r = parseAddress(find((v) => v.sapling && v.p2pkh && !v.orchard));
    assert.equal(destinationPool(r, true), 'sapling');
  });

  test('prefers the shielded receiver even when a transparent one is present', () => {
    const r = parseAddress(find((v) => v.p2pkh && v.orchard));
    assert.equal(destinationPool(r, true), 'ironwood');
  });
});

describe('network helpers', () => {
  test('ironwood activation boundary', () => {
    const h = NETWORKS.main.activation.nu6_3;
    assert.equal(ironwoodActive('main', h - 1), false);
    assert.equal(ironwoodActive('main', h), true);
    assert.equal(ironwoodActive('main', null), true);
    assert.equal(ironwoodActive('test', NETWORKS.test.activation.nu6_3 - 1), false);
  });

  test('birthday height estimates are monotonic, clamped, and err early', () => {
    const a = estimateHeightForDate('main', new Date('2023-01-01T00:00:00Z'));
    const b = estimateHeightForDate('main', new Date('2024-01-01T00:00:00Z'));
    const c = estimateHeightForDate('main', new Date('2025-01-01T00:00:00Z'));
    assert.ok(a < b && b < c);
    assert.equal(estimateHeightForDate('main', new Date('2010-01-01T00:00:00Z')), NETWORKS.main.activation.sapling);
    // One year is about 420,480 blocks at 75 s; allow generous slack, but never later than naive.
    assert.ok(b - a > 400_000 && b - a < 440_000);
  });
});
