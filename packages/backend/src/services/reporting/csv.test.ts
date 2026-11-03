import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'bun:test';
import { baseUnitsToDecimal, CsvWriter, csvCell, csvLine, writeChunk } from './csv';

describe('csvCell', () => {
  test('writes a value as it is and an absent value as an empty cell', () => {
    expect(csvCell('pi_123', 'text')).toBe('pi_123');
    expect(csvCell('42', 'number')).toBe('42');
    expect(csvCell(null, 'text')).toBe('');
  });

  test('quotes a cell holding a comma, a quote or a line break, doubling its quotes', () => {
    expect(csvCell('a,b', 'text')).toBe('"a,b"');
    expect(csvCell('say "hi"', 'text')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines', 'text')).toBe('"two\nlines"');
  });

  test('defuses a TEXT cell a spreadsheet would read as a formula, never a number cell', () => {
    for (const start of ['=', '+', '-', '@', '\t']) {
      expect(csvCell(`${start}SUM(A1)`, 'text')).toStartWith("'");
    }
    expect(csvCell('=HYPERLINK("x")', 'text')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('-500', 'number')).toBe('-500');
  });

  test('ends a line with CRLF; a cell without a kind is text', () => {
    expect(csvLine(['a', '1', null, '=b'], ['text', 'number'])).toBe("a,1,,'=b\r\n");
  });
});

describe('baseUnitsToDecimal', () => {
  test('scales by the currency’s own decimals, exactly', () => {
    expect(baseUnitsToDecimal('1999', 'EUR')).toBe('19.99');
    expect(baseUnitsToDecimal('5', 'eur')).toBe('0.05');
    expect(baseUnitsToDecimal('0', 'USD')).toBe('0.00');
    expect(baseUnitsToDecimal('1999', 'JPY')).toBe('1999');
    expect(baseUnitsToDecimal('100000001', 'FAIR')).toBe('1.00000001');
    // Beyond a float's exact range: string arithmetic keeps every digit.
    expect(baseUnitsToDecimal('9007199254740993123', 'FAIR')).toBe('90071992547.40993123');
  });

  test('keeps the sign of a balance that moved down', () => {
    expect(baseUnitsToDecimal('-1999', 'EUR')).toBe('-19.99');
    expect(baseUnitsToDecimal('-5', 'EUR')).toBe('-0.05');
    expect(baseUnitsToDecimal('-0', 'EUR')).toBe('0.00');
    expect(baseUnitsToDecimal('-0', 'JPY')).toBe('0');
  });

  test('is empty for an unknown currency or a value that is not a canonical integer', () => {
    expect(baseUnitsToDecimal('1999', 'XXX')).toBeNull();
    expect(baseUnitsToDecimal('19.99', 'EUR')).toBeNull();
    expect(baseUnitsToDecimal('0019', 'EUR')).toBeNull();
    expect(baseUnitsToDecimal(null, 'EUR')).toBeNull();
    expect(baseUnitsToDecimal('100', null)).toBeNull();
  });
});

describe('CsvWriter', () => {
  test('refuses the row that would cross its ceiling', () => {
    const csv = new CsvWriter(['text'], 8);
    expect(csv.push(['abc'])).toBe(true);
    expect(csv.push(['abcd'])).toBe(false);
    expect(new TextDecoder().decode(csv.toBytes())).toBe('abc\r\n');
  });
});

describe('writeChunk', () => {
  test('waits for drain when the buffer is full, and answers false once the stream closed', async () => {
    const out = new PassThrough({ highWaterMark: 4 });
    const pending = writeChunk(out, 'more than four bytes');
    out.resume();
    expect(await pending).toBe(true);
    out.destroy();
    expect(await writeChunk(out, 'x')).toBe(false);
  });
});
