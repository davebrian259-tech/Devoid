// CSV / pasted-text parsing for batch recipients. No dependencies.

export const DEFAULT_LIMITS = Object.freeze({ maxBytes: 2_000_000, maxRows: 5_000 });

// Prefixes of every Zcash address family we might see. Only used to decide whether a headerless
// first row is data; real validation happens in address.mjs and, authoritatively, in the engine.
const ADDRESS_PREFIX = /^(u1|utest1|uregtest1|zs1|ztestsapling1|zregtestsapling1|t1|t3|tm|t2|tex1|textest1)/i;

const HEADER_SYNONYMS = {
  address: ['address', 'addr', 'recipient', 'recipientaddress', 'to', 'toaddress', 'wallet', 'walletaddress', 'zaddr', 'unifiedaddress', 'ua', 'destination'],
  amount: ['amount', 'amountzec', 'zec', 'value', 'valuezec', 'qty', 'quantity', 'pay', 'payment'],
  amountZat: ['amountzat', 'zatoshi', 'zatoshis', 'zats', 'amountzatoshi', 'valuezat'],
  memo: ['memo', 'memotext', 'note', 'notes', 'message', 'reference', 'ref'],
  label: ['label', 'name', 'payee', 'description', 'desc', 'who', 'person', 'employee'],
};

/**
 * RFC 4180-style parser with delimiter detection (tab, comma, semicolon).
 *
 * @param {string} text
 * @param {{maxBytes?: number, maxRows?: number}} [limits]
 * @returns {{ok: true, delimiter: string, rows: {line: number, cells: string[]}[]} | {ok: false, code: string, message: string, line?: number}}
 */
export function parseCsv(text, limits = {}) {
  const { maxBytes, maxRows } = { ...DEFAULT_LIMITS, ...limits };
  if (typeof text !== 'string') return bad('format', 'Input must be text');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return bad('too_big', `File is larger than ${(maxBytes / 1e6).toFixed(0)} MB`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) return bad('binary', 'This looks like a binary file, not a CSV');

  const delimiter = detectDelimiter(text);
  /** @type {{line: number, cells: string[]}[]} */
  const rows = [];
  let cells = [];
  let cell = '';
  let inQuotes = false;
  let quoteLine = 0;
  let line = 1;
  let recordLine = 1;
  let sawContent = false;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: recordLine, cells });
    cells = [];
    sawContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      inQuotes = true;
      quoteLine = line;
      cell = '';
      sawContent = true;
    } else if (ch === delimiter) {
      endCell();
      sawContent = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
      if (rows.length > maxRows) return bad('too_many_rows', `More than ${maxRows} rows`);
    } else {
      cell += ch;
      sawContent = true;
    }
  }
  if (inQuotes) return bad('unterminated_quote', `A quoted field opened on line ${quoteLine} is never closed`, quoteLine);
  if (sawContent || cell !== '' || cells.length) endRecord();
  if (rows.length > maxRows) return bad('too_many_rows', `More than ${maxRows} rows`);
  return { ok: true, delimiter, rows };
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/).find((l) => l.trim() !== '') ?? '';
  // Tab first: spreadsheet pastes are tab separated and memos often contain commas.
  let best = ',';
  let bestCount = 0;
  for (const d of ['\t', ',', ';']) {
    let count = 0;
    let q = false;
    for (const ch of firstLine) {
      if (ch === '"') q = !q;
      else if (ch === d && !q) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ZEC_UNITS = new Set(['', 'zec']);
const ZAT_UNITS = new Set(['zat', 'zats', 'zatoshi', 'zatoshis']);

/**
 * Turn raw CSV rows into recipient records, locating columns by header name when there is a
 * header row, or positionally (address, amount, memo, label) when the first row is already data.
 *
 * @param {{line: number, cells: string[]}[]} rows
 * @returns {{ok: true, records: Record[], header: boolean, ignoredColumns: string[]} | {ok: false, code: string, message: string}}
 * @typedef {{line: number, address: string, amount: string, amountZat: string, memo: string, label: string}} Record
 */
export function mapColumns(rows) {
  if (rows.length === 0) return bad('empty', 'No rows found');
  const first = rows[0].cells.map((c) => c.trim());

  /** @type {Record<string, number>} */
  const index = {};
  /** @type {{cell: string, unit: string} | null} */
  let badUnit = null;
  first.forEach((cell, i) => {
    const n = norm(cell);
    for (const [field, names] of Object.entries(HEADER_SYNONYMS)) {
      if (names.includes(n)) {
        if (index[field] === undefined) index[field] = i;
        return;
      }
    }
    // "Amount (ZEC)", "Payment [zats]": judge the name and the unit separately. A unit that is not
    // ZEC or zatoshi ("Amount (USD)") must never be read as ZEC, so it is refused further down.
    const m = /^(.*?)[([{]([^)\]}]*)[)\]}]\s*$/.exec(cell);
    if (!m) return;
    const base = norm(m[1]);
    const unit = norm(m[2]);
    for (const [field, names] of Object.entries(HEADER_SYNONYMS)) {
      if (!names.includes(base)) continue;
      if (field === 'amount' || field === 'amountZat') {
        const target = ZAT_UNITS.has(unit) ? 'amountZat' : ZEC_UNITS.has(unit) ? 'amount' : null;
        if (target === null) badUnit ??= { cell, unit: m[2].trim() };
        else if (index[target] === undefined) index[target] = i;
      } else if (index[field] === undefined) {
        index[field] = i;
      }
      return;
    }
  });

  const hasHeader = index.address !== undefined && (index.amount !== undefined || index.amountZat !== undefined);
  let dataRows = rows;
  let ignoredColumns = [];
  if (hasHeader) {
    dataRows = rows.slice(1);
    const used = new Set(Object.values(index));
    ignoredColumns = first.filter((c, i) => !used.has(i) && c !== '');
  } else if (index.address !== undefined && badUnit) {
    return bad('amount_unit', `Column "${badUnit.cell}" is in ${badUnit.unit}, but amounts must be in ZEC. Use a ZEC column named "amount", or "amount_zat" for zatoshi.`);
  } else if (index.address !== undefined) {
    return bad('no_amount_column', 'Found an address column but no amount column. Name it "amount" (in ZEC) or "amount_zat".');
  } else if (ADDRESS_PREFIX.test(first[0] ?? '') && first.length >= 2) {
    // Headerless data: address, amount, memo, label. Width is judged over every row so a memo
    // that only appears from the second row on is not silently dropped.
    const width = Math.max(...rows.map((r) => r.cells.length));
    index.address = 0;
    index.amount = 1;
    if (width > 2) index.memo = 2;
    if (width > 3) index.label = 3;
  } else {
    return bad('no_header', 'Could not find an "address" and an "amount" column. Add a header row such as: address,amount,memo,label');
  }

  const cell = (r, field) => (index[field] === undefined ? '' : (r.cells[index[field]] ?? '').trim());
  const records = dataRows.map((r) => ({
    line: r.line,
    address: cell(r, 'address'),
    amount: cell(r, 'amount'),
    amountZat: cell(r, 'amountZat'),
    // Memos keep inner whitespace and newlines (quoted CSV fields can hold them) but lose edge padding.
    memo: (index.memo === undefined ? '' : (r.cells[index.memo] ?? '')).replace(/^\s+|\s+$/g, ''),
    label: cell(r, 'label'),
  }));
  return { ok: true, records, header: hasHeader, ignoredColumns };
}

/**
 * Parse loosely formatted text: either CSV (with or without header) or one recipient per line as
 * "<address> <amount> [memo...]" separated by spaces, tabs, commas, colons or equals signs.
 *
 * @param {string} text
 * @param {{maxBytes?: number, maxRows?: number}} [limits]
 */
export function parseBatchText(text, limits = {}) {
  if (typeof text !== 'string' || text.trim() === '') return bad('empty', 'Nothing to import');

  const csv = parseCsv(text, limits);
  if (csv.ok) {
    const mapped = mapColumns(csv.rows);
    if (mapped.ok) return { ...mapped, delimiter: csv.delimiter };
    // Fall through to the line format only when this is "not CSV with a header", not a real error.
    if (mapped.code !== 'no_header') return mapped;
  } else {
    return csv;
  }

  // Line format: "address amount memo…"
  const lines = text.split(/\r\n|\n|\r/);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const m = /^([^\s,;:=]+)[ \t,;:=]+([0-9][0-9.,]*(?:[ \t]*zec)?)(?:[ \t;]+(.*))?$/i.exec(raw);
    if (!m) {
      return bad('line_format', `Line ${i + 1} is not "address amount": ${raw.slice(0, 60)}`);
    }
    records.push({ line: i + 1, address: m[1], amount: m[2], amountZat: '', memo: (m[3] ?? '').trim(), label: '' });
  }
  if (records.length === 0) return bad('empty', 'Nothing to import');
  const maxRows = limits.maxRows ?? DEFAULT_LIMITS.maxRows;
  if (records.length > maxRows) return bad('too_many_rows', `More than ${maxRows} rows`);
  return { ok: true, records, header: false, ignoredColumns: [], delimiter: ' ' };
}

/**
 * Quote a text value for CSV output. Cells that start with a formula trigger are prefixed with a
 * single quote so spreadsheets do not execute them.
 * @param {unknown} value
 */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return quoteIfNeeded(s);
}

/**
 * Quote a numeric value for CSV output (no formula guard, so negatives stay numbers).
 * @param {number | bigint | string} value
 */
export function csvNumber(value) {
  return quoteIfNeeded(String(value));
}

function quoteIfNeeded(s) {
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function bad(code, message, line) {
  return line === undefined ? { ok: false, code, message } : { ok: false, code, message, line };
}
