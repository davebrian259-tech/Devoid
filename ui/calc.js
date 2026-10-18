// Pure helpers for the UI: amounts, fees, CSV and ZIP 321 payment requests. No DOM, so the tests
// can import this file directly.

export const ZAT = 100_000_000n;
export const TX_CHUNK = 25; // recipients per transaction, as the server sends them

/** Formats zatoshi as ZEC with at least `min` decimals, trimming trailing zeros past that. */
export function fmtZec(z, min = 2) {
  const n = BigInt(z ?? 0); const neg = n < 0n; const a = neg ? -n : n;
  const whole = (a / ZAT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let frac = (a % ZAT).toString().padStart(8, '0').replace(/0+$/, '');
  frac = frac.padEnd(min, '0');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Parses a decimal ZEC amount into zatoshi, or null. At most 8 decimals, no sign. */
export function parseZecToZat(text) {
  const s = String(text ?? '').trim().replace(/,/g, '');
  const m = /^(\d{0,8})(?:\.(\d{0,8}))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || '0') * ZAT + BigInt((m[2] || '').padEnd(8, '0'));
}

/** Recipient counts per transaction when a batch of `n` is split. */
export function chunkSizes(n, size = TX_CHUNK) {
  const out = [];
  for (let left = n; left > 0; left -= size) out.push(Math.min(size, left));
  return out;
}

/**
 * ZIP 317 fee estimate for paying `n` shielded recipients: 5,000 zat per logical action with a
 * floor of two, per transaction. Matches the engine's quotes for a wallet with few notes; a wallet
 * spending many small notes pays more, which is why the review step shows the engine's own figure.
 */
export function estimateFeeZat(n, size = TX_CHUNK) {
  return chunkSizes(n, size).reduce((sum, k) => sum + 5000n * BigInt(Math.max(2, k)), 0n);
}

/** Splits `totalZat` across `n` recipients; the first ones absorb the remainder, one zat each. */
export function splitEvenly(totalZat, n) {
  const total = BigInt(totalZat); const count = BigInt(n);
  if (count <= 0n) return [];
  const base = total / count; const extra = total % count;
  return Array.from({ length: n }, (_, i) => base + (BigInt(i) < extra ? 1n : 0n));
}

/** A CSV cell. Text that would start a spreadsheet formula is prefixed with a quote. */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text from a header row and data rows. Numbers in `numeric` columns skip the formula guard. */
export function toCsv(header, rows, numeric = []) {
  const num = new Set(numeric);
  const line = (r) => r.map((v, i) => (num.has(header[i]) ? String(v ?? '') : csvCell(v))).join(',');
  return [header.join(','), ...rows.map(line)].join('\n') + '\n';
}

/** Recipient rows back into the batch text format the server parses. */
export function rowsToBatchText(rows) {
  const any = (k) => rows.some((r) => r[k]);
  const cols = ['address', 'amount', ...(any('memo') ? ['memo'] : []), ...(any('label') ? ['label'] : [])];
  return toCsv(cols, rows.map((r) => cols.map((c) => r[c] ?? '')), ['amount']).trimEnd();
}

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decimal ZEC with no trailing zeros, as ZIP 321 writes amounts ("1", "0.25"). */
export function zip321Amount(zat) {
  const a = BigInt(zat);
  const frac = (a % ZAT).toString().padStart(8, '0').replace(/0+$/, '');
  return `${a / ZAT}${frac ? `.${frac}` : ''}`;
}

/**
 * A ZIP 321 payment request for one recipient. The memo is UTF-8, base64url without padding, as
 * the reference implementation (the zip321 crate) encodes it; only shielded addresses take one.
 */
export function zip321Uri({ address, amountZat, memo, message, label }) {
  const q = [];
  if (amountZat != null && BigInt(amountZat) > 0n) q.push(`amount=${zip321Amount(amountZat)}`);
  if (memo) q.push(`memo=${base64url(new TextEncoder().encode(memo))}`);
  if (label) q.push(`label=${encodeURIComponent(label)}`);
  if (message) q.push(`message=${encodeURIComponent(message)}`);
  return `zcash:${address}${q.length ? `?${q.join('&')}` : ''}`;
}

/** Up to two initials for an avatar. */
export function monogram(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A stable hue for a name, so a contact keeps its colour. */
export function hueOf(name) {
  let h = 0;
  for (const ch of String(name ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

/** "Today", "Yesterday" or a date, for grouping activity by day in local time. */
export function dayLabel(sec, now = new Date()) {
  if (!sec) return 'Pending';
  const d = new Date(sec * 1000);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
