/**
 * RFC 4180 CSV for reports: `,`-separated, `\r\n` rows, a cell quoted when it
 * holds a quote, a separator or a line break, a quote doubled inside one. One
 * line renderer for both ways a report leaves the gateway — stored by a report
 * run (`CsvWriter`) and streamed by a download (`writeChunk`).
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
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { CURRENCY_DECIMALS, type CurrencyCode } from '@peable.to/shared-types';

export type CsvCellKind = 'text' | 'number';

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | null, kind: CsvCellKind): string {
  if (value === null) return '';
  const safe = kind === 'text' && FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One row, `\r\n`-terminated; a cell without a kind is text. */
export function csvLine(values: readonly (string | null)[], kinds: readonly CsvCellKind[]): string {
  return `${values.map((value, i) => csvCell(value, kinds[i] ?? 'text')).join(',')}\r\n`;
}

const SIGNED_INTEGER = /^-?(0|[1-9][0-9]*)$/;

/**
 * A base-unit integer string in whole units of `currency`: `"1999"` EUR →
 * `"19.99"`, `"-5"` EUR → `"-0.05"`, `"1999"` JPY → `"1999"`, FAIR to eight
 * places. String arithmetic only: a float rounds a FairCoin amount long before
 * it reaches the cell. `null` (an empty cell) for an unknown currency or a
 * value that is not a canonical integer — never a guessed scale.
 */
export function baseUnitsToDecimal(
  amount: string | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (amount === null || amount === undefined || !SIGNED_INTEGER.test(amount)) return null;
  const code = (currency ?? '').toUpperCase();
  if (!Object.hasOwn(CURRENCY_DECIMALS, code)) return null;
  const decimals = CURRENCY_DECIMALS[code as CurrencyCode];
  if (decimals === 0) return amount === '-0' ? '0' : amount;
  const negative = amount.startsWith('-') && amount !== '-0';
  const digits = amount.replace(/^-/, '').padStart(decimals + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * A CSV being written to memory, with a byte ceiling — a report run's file:
 * `push` refuses the row that would cross it, so a report is refused before it
 * is built past what it may store.
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
    const line = csvLine(values, this.kinds);
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

/**
 * Write one chunk of a streamed report, waiting for `drain` when the socket's
 * buffer is full, so a slow client holds back the database reads instead of
 * the gateway's memory. Answers `false` once the client has gone: stop reading.
 */
export async function writeChunk(out: Writable, chunk: string): Promise<boolean> {
  if (out.destroyed || out.writableEnded) return false;
  if (out.write(chunk)) return true;
  // Both waits are cancelled once either settles, so a long download does not
  // pile up one `close` listener per drain.
  const settled = new AbortController();
  const { signal } = settled;
  const drained = once(out, 'drain', { signal }).then(
    () => true,
    () => false,
  );
  const closed = once(out, 'close', { signal }).then(
    () => false,
    () => false,
  );
  try {
    return await Promise.race([drained, closed]);
  } finally {
    settled.abort();
  }
}
