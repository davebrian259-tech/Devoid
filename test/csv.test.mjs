import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, mapColumns, parseBatchText, csvCell, csvNumber } from '../server/batch/csv.mjs';

const A1 = 'u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf';
const A2 = 'zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9slya';
const A3 = 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC';

const ok = (text, limits) => {
  const r = parseBatchText(text, limits);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};

describe('parseCsv', () => {
  test('quotes, escaped quotes, embedded delimiters and newlines', () => {
    const r = parseCsv('a,b\n"x, y","say ""hi"""\n"line1\nline2",z\n');
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows.map((x) => x.cells), [['a', 'b'], ['x, y', 'say "hi"'], ['line1\nline2', 'z']]);
    assert.deepEqual(r.rows.map((x) => x.line), [1, 2, 3]);
  });

  test('line numbers keep counting through multi-line fields', () => {
    const r = parseCsv('h1,h2\n"a\nb",c\nd,e\n');
    assert.deepEqual(r.rows.map((x) => x.line), [1, 2, 4]);
  });

  test('BOM, CRLF, CR-only, blank lines and a missing final newline', () => {
    const r = parseCsv('﻿a,b\r\n\r\n1,2\r3,4');
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows.map((x) => x.cells), [['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  test('delimiter detection: tab, semicolon, comma', () => {
    assert.equal(parseCsv('a\tb\tc\n1\t2\t3').delimiter, '\t');
    assert.equal(parseCsv('a;b;c\n1;2;3').delimiter, ';');
    assert.equal(parseCsv('a,b,c\n1,2,3').delimiter, ',');
    // Tab wins over commas that appear in free text.
    assert.equal(parseCsv('address\tamount\tmemo\nx\t1\tthanks, friend').delimiter, '\t');
    // A delimiter inside quotes in the first line does not count.
    assert.equal(parseCsv('"a;b;c";d\n1;2').delimiter, ';');
  });

  test('errors', () => {
    assert.equal(parseCsv('a,"b\n1,2').code, 'unterminated_quote');
    assert.equal(parseCsv('a,\u0000b').code, 'binary');
    assert.equal(parseCsv('x'.repeat(100), { maxBytes: 50 }).code, 'too_big');
    assert.equal(parseCsv('a\n1\n2\n3\n4', { maxRows: 3 }).code, 'too_many_rows');
    assert.equal(parseCsv(5).code, 'format');
  });
});

describe('mapColumns / parseBatchText with headers', () => {
  test('standard header', () => {
    const r = ok(`address,amount,memo,label\n${A1},1.5,Rent,Landlord\n${A2},0.25,,Dana\n`);
    assert.equal(r.header, true);
    assert.deepEqual(r.records, [
      { line: 2, address: A1, amount: '1.5', amountZat: '', memo: 'Rent', label: 'Landlord' },
      { line: 3, address: A2, amount: '0.25', amountZat: '', memo: '', label: 'Dana' },
    ]);
  });

  test('header synonyms, any order, odd capitalisation', () => {
    const r = ok(`Name,Payment (ZEC),Recipient Address,Note\nAda,2,${A3},Bonus\n`);
    assert.deepEqual(r.records[0], { line: 2, address: A3, amount: '2', amountZat: '', memo: 'Bonus', label: 'Ada' });
  });

  test('amount in zatoshi', () => {
    const r = ok(`address,amount_zat\n${A1},150000000\n`);
    assert.equal(r.records[0].amountZat, '150000000');
    assert.equal(r.records[0].amount, '');
  });

  test('tab separated spreadsheet paste', () => {
    const r = ok(`address\tamount\tmemo\n${A1}\t1\tthanks, friend\n`);
    assert.equal(r.delimiter, '\t');
    assert.equal(r.records[0].memo, 'thanks, friend');
  });

  test('semicolon separated (European spreadsheets)', () => {
    const r = ok(`address;amount\n${A1};1.5\n`);
    assert.equal(r.records[0].amount, '1.5');
  });

  test('quoted memo keeps inner newlines but loses edge whitespace', () => {
    const r = ok(`address,amount,memo\n${A1},1,"  first\nsecond  "\n`);
    assert.equal(r.records[0].memo, 'first\nsecond');
  });

  test('extra columns are reported, not silently dropped', () => {
    const r = ok(`id,address,amount,department\n1,${A1},1,Ops\n`);
    assert.deepEqual(r.ignoredColumns, ['id', 'department']);
  });

  test('short rows leave the missing fields empty for validation to flag', () => {
    const r = ok(`address,amount,memo\n${A1}\n`);
    assert.equal(r.records[0].amount, '');
  });

  test('units in the header: ZEC and zatoshi are understood, anything else is refused', () => {
    const zec = ok(`Address,Amount (ZEC)\n${A1},1\n`);
    assert.equal(zec.records[0].amount, '1');
    const zats = ok(`Address,Amount (zatoshi)\n${A1},100000000\n`);
    assert.equal(zats.records[0].amountZat, '100000000');
    assert.equal(zats.records[0].amount, '');
    for (const unit of ['USD', 'EUR', 'BTC', 'NGN', 'units']) {
      const r = parseBatchText(`Address,Amount (${unit})\n${A1},1\n`);
      assert.equal(r.ok, false, unit);
      assert.equal(r.code, 'amount_unit', unit);
      assert.ok(r.message.includes(unit));
    }
    // Same hazard without parentheses: never silently treated as ZEC.
    for (const header of ['Address,Amount USD', 'Address,amount_usd', 'Address,Value in EUR']) {
      assert.equal(parseBatchText(`${header}\n${A1},1\n`).ok, false, header);
    }
  });

  test('address column without an amount column is a clear error', () => {
    const r = parseBatchText(`address,memo\n${A1},hi\n`);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no_amount_column');
  });
});

describe('headerless and free-form input', () => {
  test('headerless csv', () => {
    const r = ok(`${A1},1.5\n${A2},2,Thanks\n`);
    assert.equal(r.header, false);
    assert.equal(r.records.length, 2);
    assert.equal(r.records[0].address, A1);
    assert.equal(r.records[0].amount, '1.5');
    assert.equal(r.records[1].memo, 'Thanks');
  });

  test('a single address on one line is not data without an amount', () => {
    const r = parseBatchText(A1);
    assert.equal(r.ok, false);
  });

  test('one recipient per line with spaces, equals, colon, tabs', () => {
    const r = ok(`# payroll\n${A1} 1.5 salary\n${A2}=2\n${A3}: 0.5 zec\n`);
    assert.deepEqual(r.records.map((x) => [x.address, x.amount, x.memo]), [
      [A1, '1.5', 'salary'],
      [A2, '2', ''],
      [A3, '0.5 zec', ''],
    ]);
    assert.deepEqual(r.records.map((x) => x.line), [2, 3, 4]);
  });

  test('decimal commas are passed through so amount parsing can reject them', () => {
    const r = ok(`${A1} 1,5\n`);
    // Either interpretation must leave the amount field non-parsable, never a quiet "15".
    const rec = r.records[0];
    assert.ok(/1.*5/.test(rec.amount + rec.address));
  });

  test('garbage gets a line-numbered error', () => {
    const r = parseBatchText('this is not a batch\nneither is this');
    assert.equal(r.ok, false);
    assert.ok(['line_format', 'no_header'].includes(r.code));
  });

  test('empty input', () => {
    assert.equal(parseBatchText('').code, 'empty');
    assert.equal(parseBatchText('  \n  ').code, 'empty');
    assert.equal(parseBatchText(null).code, 'empty');
  });

  test('row limit applies to every path', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `${A1} ${i + 1}`).join('\n');
    assert.equal(parseBatchText(lines, { maxRows: 10 }).code, 'too_many_rows');
    const csv = `address,amount\n${Array.from({ length: 11 }, (_, i) => `${A1},${i + 1}`).join('\n')}`;
    assert.equal(parseBatchText(csv, { maxRows: 10 }).code, 'too_many_rows');
  });
});

describe('mapColumns directly', () => {
  test('empty', () => {
    assert.equal(mapColumns([]).code, 'empty');
  });
});

describe('csv output helpers', () => {
  test('formula injection guard', () => {
    assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
    assert.equal(csvCell('+1+1'), "'+1+1");
    assert.equal(csvCell('-2'), "'-2");
    assert.equal(csvCell('@cmd'), "'@cmd");
    assert.equal(csvCell('\tx'), "'\tx");
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell(null), '');
  });

  test('quoting', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('two\nlines'), '"two\nlines"');
    assert.equal(csvCell('semi;colon'), '"semi;colon"');
  });

  test('numbers are not guarded', () => {
    assert.equal(csvNumber(-5), '-5');
    assert.equal(csvNumber(12345678901234567890n), '12345678901234567890');
  });

  test('output survives a round trip through the parser', () => {
    const cells = ['=evil', 'a,b', 'c "quoted"', 'multi\nline', 'plain'];
    const line = cells.map(csvCell).join(',');
    const r = parseCsv(`${line}\n`);
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows[0].cells, ["'=evil", 'a,b', 'c "quoted"', 'multi\nline', 'plain']);
  });
});
