import { SEARCH_QUERY_MAX_CLAUSES, SEARCH_QUERY_MAX_LENGTH } from '@peable.to/shared-types';

/**
 * Stripe's search query language, parsed into a flat list of clauses.
 *
 * ## The language
 *
 * ```
 * query   := clause ( separator clause )*            -- at most 10 clauses
 * separator := spaces | spaces "AND" spaces | spaces "OR" spaces   -- case-insensitive
 * clause  := [ "-" ] field operator value
 * field   := name ( "." name )* | "metadata" "[" quoted "]"
 * name    := [a-z_][a-z0-9_]*
 * operator := ":" | "~" | ">" | "<" | ">=" | "<=" | "="
 * value   := quoted | digits | "null" | "true" | "false"
 * quoted  := '"' … '"' | "'" … "'"      -- `\` escapes the next character
 * ```
 *
 * Every rule here is Stripe's, and each refusal is deliberate:
 *
 * - **All AND or all OR.** A space is an AND. Mixing the two (or a space with
 *   an OR) is refused rather than given a precedence: Stripe has none and no
 *   parentheses, and a precedence the caller did not intend is a filter that
 *   silently answers something else.
 * - **Strings are quoted.** A bare word is refused, so `email:jenny@example.com`
 *   fails loudly instead of being read as something it is not. Numbers, `null`
 *   and the booleans may be bare.
 * - **Integers only.** Amounts are in the currency's smallest unit and times
 *   are Unix seconds, so a decimal point is always a mistake.
 *
 * What a clause MEANS — whether the field exists, whether its type takes the
 * operator — is the compiler's (`compile.ts`), because it depends on the
 * resource. This module knows only the grammar and never sees SQL.
 *
 * Every error carries the 0-based position of the character it is about, and
 * the route answers it as a 400 with `param: 'query'`.
 */

export type SearchOperator = ':' | '~' | '>' | '<' | '>=' | '<=' | '=';

export type SearchValue =
  | { readonly kind: 'string'; readonly value: string }
  /** A non-negative integer, canonical (no leading zeros). */
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' };

export interface SearchClause {
  /** `status`, `billing_details.email`, `metadata`. */
  readonly field: string;
  /** The key of `metadata['key']`, when the field is written that way. */
  readonly metadataKey?: string;
  readonly negated: boolean;
  readonly operator: SearchOperator;
  readonly value: SearchValue;
  /** Where the clause starts (its `-` when negated). */
  readonly position: number;
  /** Where its value starts. */
  readonly valuePosition: number;
}

export interface SearchQuery {
  /** How the clauses combine; `and` for a single clause. */
  readonly combinator: 'and' | 'or';
  readonly clauses: readonly SearchClause[];
}

/** A query the caller must fix, and where. */
export class SearchQueryError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} (at position ${String(position)})`);
    this.name = 'SearchQueryError';
  }
}

/** The metadata key limit (ADR 0014 D1), restated where a key is read. */
const METADATA_KEY_MAX_LENGTH = 40;
/** No amount or timestamp needs more; a longer run of digits is a typo or a probe. */
const NUMBER_MAX_DIGITS = 30;

const OPERATORS: readonly SearchOperator[] = ['>=', '<=', ':', '~', '>', '<', '='];
const NAME = /[a-z_][a-z0-9_]*/y;
const WHITESPACE = /\s/;

class Scanner {
  index = 0;
  constructor(readonly text: string) {}

  get done(): boolean {
    return this.index >= this.text.length;
  }

  peek(offset = 0): string | undefined {
    return this.text[this.index + offset];
  }

  /** Skip whitespace; how much was skipped. */
  skipSpace(): number {
    const start = this.index;
    while (!this.done && WHITESPACE.test(this.text[this.index] ?? '')) this.index += 1;
    return this.index - start;
  }

  /**
   * The keyword `AND` / `OR` at the cursor, followed by whitespace or the end —
   * consumed. `order:…` is a field, not `OR` followed by `der`.
   */
  keyword(): 'and' | 'or' | null {
    for (const word of ['and', 'or'] as const) {
      const candidate = this.text.slice(this.index, this.index + word.length);
      const after = this.text[this.index + word.length];
      if (candidate.toLowerCase() === word && (after === undefined || WHITESPACE.test(after))) {
        this.index += word.length;
        return word;
      }
    }
    return null;
  }

  name(): string | null {
    NAME.lastIndex = this.index;
    const match = NAME.exec(this.text);
    if (!match) return null;
    this.index += match[0].length;
    return match[0];
  }

  fail(message: string, position = this.index): never {
    throw new SearchQueryError(message, position);
  }
}

function describe(char: string | undefined): string {
  return char === undefined ? 'the end of the query' : `'${char}'`;
}

/** A quoted string at the cursor; the cursor is on its opening quote. */
function quoted(scanner: Scanner): string {
  const open = scanner.index;
  const quote = scanner.peek();
  scanner.index += 1;
  let out = '';
  while (!scanner.done) {
    const char = scanner.peek() as string;
    if (char === '\\') {
      const next = scanner.peek(1);
      if (next === undefined) break;
      out += next;
      scanner.index += 2;
      continue;
    }
    if (char === quote) {
      scanner.index += 1;
      return out;
    }
    out += char;
    scanner.index += 1;
  }
  return scanner.fail('unterminated string: a quoted value needs its closing quote', open);
}

function field(scanner: Scanner): { field: string; metadataKey?: string } {
  const start = scanner.index;
  if (scanner.peek() === '(' || scanner.peek() === ')') {
    scanner.fail('parentheses are not supported: a query is either all AND or all OR clauses');
  }
  const segments: string[] = [];
  for (;;) {
    const name = scanner.name();
    if (name === null) {
      scanner.fail(
        segments.length === 0
          ? `expected a field name, found ${describe(scanner.peek())}`
          : `expected a field name after '.', found ${describe(scanner.peek())}`,
      );
    }
    segments.push(name);
    if (scanner.peek() !== '.') break;
    scanner.index += 1;
  }
  const path = segments.join('.');
  if (scanner.peek() !== '[') return { field: path };
  if (path !== 'metadata') {
    scanner.fail(`only metadata takes a key in brackets, not '${path}'`, start);
  }
  scanner.index += 1;
  const keyAt = scanner.index;
  const quote = scanner.peek();
  if (quote !== '"' && quote !== "'") {
    scanner.fail(`a metadata key is quoted: metadata['key'], found ${describe(quote)}`);
  }
  const key = quoted(scanner);
  if (key.length === 0 || key.length > METADATA_KEY_MAX_LENGTH) {
    scanner.fail(`a metadata key is 1 to ${String(METADATA_KEY_MAX_LENGTH)} characters`, keyAt);
  }
  if (scanner.peek() !== ']') {
    scanner.fail(`expected ']' after the metadata key, found ${describe(scanner.peek())}`);
  }
  scanner.index += 1;
  return { field: path, metadataKey: key };
}

function operator(scanner: Scanner, fieldName: string): SearchOperator {
  for (const op of OPERATORS) {
    if (scanner.text.startsWith(op, scanner.index)) {
      scanner.index += op.length;
      return op;
    }
  }
  return scanner.fail(
    `expected an operator (:, ~, >, <, >=, <=, =) after '${fieldName}', found ${describe(scanner.peek())}`,
  );
}

function value(scanner: Scanner, op: SearchOperator): SearchValue {
  const start = scanner.index;
  const first = scanner.peek();
  if (first === '"' || first === "'") return { kind: 'string', value: quoted(scanner) };
  if (first === undefined || WHITESPACE.test(first)) {
    scanner.fail(`expected a value after '${op}'`);
  }
  while (!scanner.done && !WHITESPACE.test(scanner.peek() ?? '')) scanner.index += 1;
  const word = scanner.text.slice(start, scanner.index);
  const lower = word.toLowerCase();
  if (lower === 'null') return { kind: 'null' };
  if (lower === 'true' || lower === 'false') return { kind: 'boolean', value: lower === 'true' };
  if (/^[0-9]+$/.test(word)) {
    if (word.length > NUMBER_MAX_DIGITS) {
      scanner.fail(`a number is at most ${String(NUMBER_MAX_DIGITS)} digits`, start);
    }
    return { kind: 'number', value: BigInt(word).toString() };
  }
  if (/^-?[0-9]*\.?[0-9]+$/.test(word) || /^-[0-9]+$/.test(word)) {
    scanner.fail(
      'a number is a non-negative integer: amounts are in the smallest currency unit and times in Unix seconds',
      start,
    );
  }
  return scanner.fail(`a text value must be quoted: write "${word}"`, start);
}

function clause(scanner: Scanner): SearchClause {
  const position = scanner.index;
  const negated = scanner.peek() === '-';
  if (negated) scanner.index += 1;
  const named = field(scanner);
  const op = operator(scanner, named.field);
  const valuePosition = scanner.index;
  const parsed = value(scanner, op);
  const next = scanner.peek();
  if (next !== undefined && !WHITESPACE.test(next)) {
    scanner.fail(`expected a space, AND or OR after a clause, found ${describe(next)}`);
  }
  return {
    field: named.field,
    ...(named.metadataKey !== undefined ? { metadataKey: named.metadataKey } : {}),
    negated,
    operator: op,
    value: parsed,
    position,
    valuePosition,
  };
}

/**
 * Parse one query.
 *
 * @throws {SearchQueryError} the query is not in the language, with where.
 */
export function parseSearchQuery(text: string): SearchQuery {
  if (text.length > SEARCH_QUERY_MAX_LENGTH) {
    throw new SearchQueryError(
      `a query is at most ${String(SEARCH_QUERY_MAX_LENGTH)} characters`,
      SEARCH_QUERY_MAX_LENGTH,
    );
  }
  const scanner = new Scanner(text);
  scanner.skipSpace();
  if (scanner.done) scanner.fail('the query is empty', 0);

  const clauses: SearchClause[] = [];
  let combinator: 'and' | 'or' | null = null;
  for (;;) {
    if (clauses.length === SEARCH_QUERY_MAX_CLAUSES) {
      scanner.fail(`a query has at most ${String(SEARCH_QUERY_MAX_CLAUSES)} clauses`);
    }
    clauses.push(clause(scanner));
    scanner.skipSpace();
    if (scanner.done) break;
    const separatorAt = scanner.index;
    const separator = scanner.keyword() ?? 'and';
    if (combinator !== null && combinator !== separator) {
      scanner.fail(
        'AND and OR cannot be combined in one query (a space is an AND); use one of them throughout',
        separatorAt,
      );
    }
    combinator = separator;
    scanner.skipSpace();
    if (scanner.done) {
      scanner.fail(`expected a clause after ${separator.toUpperCase()}`);
    }
  }
  return { combinator: combinator ?? 'and', clauses };
}
