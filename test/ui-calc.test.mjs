import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtZec, parseZecToZat, chunkSizes, estimateFeeZat, padBucket, TX_CHUNK, splitEvenly, csvCell, toCsv, rowsToBatchText, zip321Uri, zip321Amount, monogram, hueOf, dayLabel } from '../ui/calc.js';

test('formats and parses ZEC amounts', () => {
  assert.equal(fmtZec(1_590_000_000n), '15.90');
  assert.equal(fmtZec(123_456_789_000_000n), '1,234,567.89');
  assert.equal(fmtZec(15_000n, 4), '0.00015');
  assert.equal(fmtZec(-250_000_000n), '-2.50');
  assert.equal(parseZecToZat('0.25'), 25_000_000n);
  assert.equal(parseZecToZat('1,000.00000001'), 100_000_000_001n);
  assert.equal(parseZecToZat('.5'), 50_000_000n);
  for (const bad of ['', '.', '-1', '1.123456789', 'abc', '1e3']) assert.equal(parseZecToZat(bad), null, bad);
});

test('fee estimate counts each payment and the change, as the engine quotes on mainnet', () => {
  // Mainnet: 2 payments plus change paid 15,000 zat (82731e0e…, block 3,522,904).
  assert.equal(estimateFeeZat(1), 10_000n); // the two-action floor
  assert.equal(estimateFeeZat(2), 15_000n);
  assert.equal(estimateFeeZat(10), 55_000n);
  assert.equal(estimateFeeZat(25), 130_000n);
  assert.equal(estimateFeeZat(30), 130_000n + 30_000n); // 25 + 5 across two transactions
  assert.deepEqual(chunkSizes(51), [25, 25, 1]);
  assert.equal(estimateFeeZat(51), 130_000n * 2n + 10_000n);
  assert.equal(estimateFeeZat(0), 0n);
});

test('splitting a total never loses or invents a zatoshi', () => {
  const parts = splitEvenly(100_000_001n, 3);
  assert.deepEqual(parts, [33_333_334n, 33_333_334n, 33_333_333n]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 100_000_001n);
  assert.deepEqual(splitEvenly(5n, 0), []);
});

test('CSV output is quoted and formula-safe', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(toCsv(['address', 'amount'], [['u1x', '-1.5']], ['amount']), 'address,amount\nu1x,-1.5\n');
  assert.equal(rowsToBatchText([{ address: 'u1a', amount: '0.1' }, { address: 'u1b', amount: '0.2', memo: 'hi, there' }]),
    'address,amount,memo\nu1a,0.1,\nu1b,0.2,"hi, there"');
});

test('ZIP 321 requests match the reference implementation', () => {
  // Test vector from the zip321 crate: memo "This is a simple memo." as base64url without padding.
  const uri = zip321Uri({ address: 'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez', amountZat: 100_000_000n, memo: 'This is a simple memo.', message: 'Thank you for your purchase' });
  assert.equal(uri, 'zcash:ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg&message=Thank%20you%20for%20your%20purchase');
  assert.equal(zip321Amount(12_345_600_000n), '123.456');
  assert.equal(zip321Amount(2_099_999_999_999_999n), '20999999.99999999');
  assert.equal(zip321Uri({ address: 'tmX' }), 'zcash:tmX');
  // Non-ASCII memos are UTF-8 before encoding, and never carry padding or +/.
  assert.match(zip321Uri({ address: 'u1', memo: 'thanks ✨' }), /memo=[A-Za-z0-9_-]+$/);
});

test('avatars and day labels', () => {
  assert.equal(monogram('Ada Lovelace'), 'AL');
  assert.equal(monogram('payroll'), 'PA');
  assert.equal(monogram('  '), '?');
  assert.equal(hueOf('Ada'), hueOf('Ada'));
  const now = new Date(2026, 9, 18, 15, 0);
  assert.equal(dayLabel(null, now), 'Pending');
  assert.equal(dayLabel(new Date(2026, 9, 18, 1, 0).getTime() / 1000, now), 'Today');
  assert.equal(dayLabel(new Date(2026, 9, 17, 23, 0).getTime() / 1000, now), 'Yesterday');
});

test('padding rounds a transaction up to a bucket, and charges an action for each', () => {
  // The bucket rule, mirrored from engine/src/spend.rs.
  assert.equal(padBucket(1), 5);
  assert.equal(padBucket(5), 5);
  assert.equal(padBucket(6), 10);
  assert.equal(padBucket(11), 25);
  assert.equal(padBucket(26), 26); // past the last bucket, a transaction is as wide as it is

  // Three recipients: the chain sees five outputs instead of three, for two more actions.
  assert.equal(estimateFeeZat(3).toString(), '20000');
  assert.equal(estimateFeeZat(3, TX_CHUNK, true).toString(), '30000');
  // What the engine quoted for the same batch on testnet (txid 4fbde366…).
  assert.equal(estimateFeeZat(3, TX_CHUNK, true) - estimateFeeZat(3), 10000n);

  // A batch of full transactions is already at the top bucket, so padding is free.
  assert.equal(estimateFeeZat(60, TX_CHUNK, true), estimateFeeZat(60));
  // One that is not pays for the difference.
  assert.ok(estimateFeeZat(11, TX_CHUNK, true) > estimateFeeZat(11));
});
