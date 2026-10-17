// ZEC <-> zatoshi conversion. Money never touches floating point: everything is BigInt
// until the single, checked conversion to a JSON number at the engine boundary.

export const ZAT_PER_ZEC = 100_000_000n;
/** Total supply cap (21 million ZEC) in zatoshi; also the consensus MAX_MONEY. */
export const MAX_MONEY_ZAT = 21_000_000n * ZAT_PER_ZEC;

/**
 * Parse a user-typed ZEC amount into zatoshi.
 *
 * Strict on purpose. A wrong amount is unrecoverable once broadcast, so anything ambiguous is
 * rejected with a reason rather than guessed at: thousands separators, decimal commas, scientific
 * notation, more than 8 decimals (no silent rounding), zero, negatives, and anything above the
 * total supply.
 *
 * @param {unknown} input
 * @returns {{ok: true, zat: bigint} | {ok: false, code: string, message: string}}
 */
export function parseZec(input) {
  if (typeof input !== 'string') {
    return fail('format', 'Amount must be text such as 0.25');
  }
  const s = input.trim().replace(/\s*zec$/i, '').trim();
  if (s === '') return fail('empty', 'Amount is empty');
  if (/[,_'\u00a0\u2009\u202f]/.test(s) || /\d\s+\d/.test(s)) {
    return fail('separator', 'Use a dot for decimals and no thousands separators (for example 1250.5)');
  }
  if (/^[+-]/.test(s)) {
    return fail('negative', s.startsWith('-') ? 'Amount cannot be negative' : 'Remove the leading plus sign');
  }
  const m = /^(?:(\d+)(?:\.(\d+))?|\.(\d+))$/.exec(s);
  if (!m) {
    return fail('format', /e/i.test(s) ? 'Scientific notation is not accepted; write the full decimal' : 'Not a valid amount');
  }
  const whole = m[1] ?? '0';
  const frac = m[2] ?? m[3] ?? '';
  if (frac.length > 8) {
    return fail('precision', `ZEC has 8 decimal places, this has ${frac.length}. It will not be rounded for you`);
  }
  const wholeTrimmed = whole.replace(/^0+(?=\d)/, '');
  if (wholeTrimmed.length > 9) return fail('too_large', 'Amount exceeds the total supply of ZEC');
  const zat = BigInt(wholeTrimmed) * ZAT_PER_ZEC + BigInt(frac.padEnd(8, '0'));
  if (zat === 0n) return fail('zero', 'Amount must be greater than zero');
  if (zat > MAX_MONEY_ZAT) return fail('too_large', 'Amount exceeds the total supply of ZEC');
  return { ok: true, zat };
}

/**
 * Parse an integer zatoshi amount (digits only).
 * @param {unknown} input
 * @returns {{ok: true, zat: bigint} | {ok: false, code: string, message: string}}
 */
export function parseZat(input) {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) return fail('format', 'Zatoshi amount must be a whole number');
    input = String(input);
  }
  if (typeof input !== 'string') return fail('format', 'Zatoshi amount must be a whole number');
  const s = input.trim();
  if (!/^\d{1,16}$/.test(s)) return fail('format', 'Zatoshi amount must be a whole number');
  const zat = BigInt(s);
  if (zat === 0n) return fail('zero', 'Amount must be greater than zero');
  if (zat > MAX_MONEY_ZAT) return fail('too_large', 'Amount exceeds the total supply of ZEC');
  return { ok: true, zat };
}

/**
 * Format zatoshi as a ZEC string with no float math.
 * @param {bigint | number} zatoshi
 * @param {{minDecimals?: number, maxDecimals?: number}} [opts]
 */
export function formatZec(zatoshi, opts = {}) {
  const { minDecimals = 0, maxDecimals = 8 } = opts;
  let z = BigInt(zatoshi);
  const neg = z < 0n;
  if (neg) z = -z;
  const whole = z / ZAT_PER_ZEC;
  let frac = (z % ZAT_PER_ZEC).toString().padStart(8, '0').slice(0, Math.max(0, maxDecimals));
  frac = frac.replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Convert zatoshi to a JSON-safe number. Throws if it would lose precision, which can only
 * happen for values above the supply cap and therefore indicates a bug.
 * @param {bigint} zat
 */
export function zatToNumber(zat) {
  if (zat < 0n || zat > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('zatoshi value outside the safe JSON integer range');
  }
  return Number(zat);
}

/**
 * Sum bigint zatoshi values.
 * @param {Iterable<bigint>} values
 */
export function sumZat(values) {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

function fail(code, message) {
  return { ok: false, code, message };
}
