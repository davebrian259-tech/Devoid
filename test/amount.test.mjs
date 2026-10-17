import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZAT_PER_ZEC, MAX_MONEY_ZAT, parseZec, parseZat, formatZec, zatToNumber, sumZat,
} from '../server/batch/amount.mjs';

const show = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x));
const zat = (s) => {
  const r = parseZec(s);
  assert.equal(r.ok, true, `${show(s)} should parse: ${show(r)}`);
  return r.zat;
};
const code = (s) => {
  const r = parseZec(s);
  assert.equal(r.ok, false, `${show(s)} should be rejected`);
  return r.code;
};

describe('parseZec', () => {
  test('exact conversions, no floating point', () => {
    assert.equal(zat('1'), 100_000_000n);
    assert.equal(zat('0.1'), 10_000_000n);
    assert.equal(zat('0.00000001'), 1n);
    assert.equal(zat('1.23456789'), 123_456_789n);
    assert.equal(zat('21000000'), MAX_MONEY_ZAT);
    assert.equal(zat('0.1') + zat('0.2'), zat('0.3'));
    assert.equal(zat('4.35') * 100n, 43_500_000_000n); // 4.35 * 100 is 434.99999999999994 in floating point
    assert.equal(zat('1.005'), 100_500_000n);
  });

  test('tolerates harmless formatting', () => {
    assert.equal(zat('  1.5  '), 150_000_000n);
    assert.equal(zat('1.5 ZEC'), 150_000_000n);
    assert.equal(zat('1.5zec'), 150_000_000n);
    assert.equal(zat('.5'), 50_000_000n);
    assert.equal(zat('0001.50'), 150_000_000n);
    assert.equal(zat('0.50000000'), 50_000_000n);
  });

  test('rejects anything ambiguous instead of guessing', () => {
    assert.equal(code(''), 'empty');
    assert.equal(code('   '), 'empty');
    assert.equal(code('abc'), 'format');
    assert.equal(code('NaN'), 'format');
    assert.equal(code('Infinity'), 'format');
    assert.equal(code('0x10'), 'format');
    assert.equal(code('1.'), 'format');
    assert.equal(code('1..5'), 'format');
    assert.equal(code('1.5.2'), 'format');
    assert.equal(code('٣'), 'format'); // Arabic-Indic digit
    assert.equal(code('１２'), 'format'); // full-width digits
  });

  test('thousands separators and decimal commas are errors, not silently reinterpreted', () => {
    for (const s of ['1,000', '1,5', '1.000,50', '1_000', "1'000", '1 000', '1 000', '1 000', '1 000']) {
      assert.equal(code(s), 'separator', s);
    }
  });

  test('signs and scientific notation', () => {
    assert.equal(code('-1'), 'negative');
    assert.equal(code('-0.5'), 'negative');
    assert.equal(code('+1'), 'negative');
    assert.equal(code('1e3'), 'format');
    assert.equal(code('1E-8'), 'format');
  });

  test('zero, precision and supply limits', () => {
    assert.equal(code('0'), 'zero');
    assert.equal(code('0.0'), 'zero');
    assert.equal(code('0.00000000'), 'zero');
    assert.equal(code('0.000000001'), 'precision');
    assert.equal(code('1.123456789'), 'precision');
    assert.equal(code('21000000.00000001'), 'too_large');
    assert.equal(code('21000001'), 'too_large');
    assert.equal(code('1000000000'), 'too_large');
    assert.equal(code('99999999999999999999'), 'too_large');
  });

  test('non-string input', () => {
    for (const v of [1, 0.5, null, undefined, {}, 10n]) assert.equal(code(v), 'format');
  });
});

describe('parseZat', () => {
  test('accepts whole numbers', () => {
    assert.equal(parseZat('1').zat, 1n);
    assert.equal(parseZat(' 150000000 ').zat, 150_000_000n);
    assert.equal(parseZat(42).zat, 42n);
    assert.equal(parseZat(String(MAX_MONEY_ZAT)).zat, MAX_MONEY_ZAT);
  });

  test('rejects everything else', () => {
    for (const v of ['', '0', '-1', '1.5', '1e3', '1,000', 'abc', 1.5, NaN, Infinity, 2 ** 60, null, undefined, '12345678901234567']) {
      assert.equal(parseZat(v).ok, false, String(v));
    }
    assert.equal(parseZat('0').code, 'zero');
    assert.equal(parseZat(String(MAX_MONEY_ZAT + 1n)).code, 'too_large');
  });
});

describe('formatZec', () => {
  test('exact and trimmed', () => {
    assert.equal(formatZec(1n), '0.00000001');
    assert.equal(formatZec(ZAT_PER_ZEC), '1');
    assert.equal(formatZec(150_000_000n), '1.5');
    assert.equal(formatZec(0n), '0');
    assert.equal(formatZec(MAX_MONEY_ZAT), '21000000');
    assert.equal(formatZec(123_456_789n), '1.23456789');
  });

  test('options and negatives', () => {
    assert.equal(formatZec(150_000_000n, { minDecimals: 2 }), '1.50');
    assert.equal(formatZec(ZAT_PER_ZEC, { minDecimals: 4 }), '1.0000');
    assert.equal(formatZec(123_456_789n, { maxDecimals: 4 }), '1.2345');
    assert.equal(formatZec(-50_000_000n), '-0.5');
    assert.equal(formatZec(5000), '0.00005');
  });

  test('round trip with parseZec for varied amounts', () => {
    let x = 12345n;
    for (let i = 0; i < 500; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) % (MAX_MONEY_ZAT + 1n);
      if (x === 0n) continue;
      assert.equal(zat(formatZec(x)), x);
    }
  });
});

describe('zatToNumber and sumZat', () => {
  test('safe conversion', () => {
    assert.equal(zatToNumber(0n), 0);
    assert.equal(zatToNumber(MAX_MONEY_ZAT), 2_100_000_000_000_000);
    assert.throws(() => zatToNumber(-1n), RangeError);
    assert.throws(() => zatToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n), RangeError);
  });

  test('sum', () => {
    assert.equal(sumZat([]), 0n);
    assert.equal(sumZat([1n, 2n, 3n]), 6n);
    assert.equal(sumZat(new Set([5n, 7n])), 12n);
  });
});
