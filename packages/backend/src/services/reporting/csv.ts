/**
 * RFC 4180 CSV for reports: `,`-separated, `\r\n` rows, a cell quoted when it
 * holds a quote, a separator or a line break, a quote doubled inside one.
 *
 * ## Spreadsheet formulas are neutralized in TEXT cells
 *
 * A report is opened in a spreadsheet, and a cell that starts with `=`, `+`,
 * `-`, `@`, a tab or a carriage return is evaluated there as a formula. Text a
 * payer wrote (a description, a receipt email) reaches these cells, so a text
 * cell starting with one of them is prefixed with `'`, the OWASP rule. Number
 * cells are never prefixed: a signed amount (`-500`) is data, and the column
 * kind — not the content — is what says which a cell is.
 */

export type CsvCellKind = 'text' | 'number';

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string | null, kind: CsvCellKind): string {
  if (value === null) return '';
  const safe = kind === 'text' && FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * A CSV being written, with a byte ceiling: `push` refuses the row that would
 * cross it, so a report is refused before it is built past what it may store.
 */
export class CsvWriter {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly kinds: readonly CsvCellKind[],
    private readonly maxBytes: number,
  ) {}

  /** @returns `false` when the row would cross the ceiling (it is not written). */
  push(values: readonly (string | null)[]): boolean {
    const line = `${values.map((value, i) => cell(value, this.kinds[i] ?? 'text')).join(',')}\r\n`;
    const size = this.encoder.encode(line).byteLength;
    if (this.bytes + size > this.maxBytes) return false;
    this.chunks.push(line);
    this.bytes += size;
    return true;
  }

  toBytes(): Uint8Array {
    return this.encoder.encode(this.chunks.join(''));
  }
}
