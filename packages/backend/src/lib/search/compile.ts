import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { SEARCH_SUBSTRING_MIN_LENGTH } from '@peable.to/shared-types';
import {
  type SearchClause,
  type SearchOperator,
  type SearchQuery,
  SearchQueryError,
  type SearchValue,
} from './parser';

/**
 * A parsed query → ONE parameterised predicate over one resource's table.
 *
 * ## What the field registry is
 *
 * Each searchable resource declares its fields (`db/search/searchFields.ts`):
 * a name as the caller writes it, the SQL expression it reads, and a TYPE. The
 * type decides everything else — which operators the field takes, which
 * values, how a value is normalized and the exact predicate written. A field
 * that is not in the registry does not exist, so a query can reach only the
 * columns somebody decided to expose.
 *
 * ## Why nothing here can be injected
 *
 * A value from the query only ever enters the SQL as a BOUND PARAMETER of
 * drizzle's `sql` template. The only `sql.raw` in this file renders an operator
 * or a boolean keyword from a fixed table below — never caller text — and the
 * expressions come from the registry, which is code. Substring matching uses
 * `strpos`, not `LIKE`, so `%` and `_` in a value are characters and not
 * wildcards.
 *
 * ## Merchant scope is not here
 *
 * The predicate is AND-ed beneath the repository's own `merchant_id = …`
 * (and every reference subquery repeats it), so even a predicate that matched
 * every row would match only the caller's.
 */

/** Free text: `:` is a case-insensitive equality, `~` a case-insensitive substring. */
export interface StringSearchField {
  readonly type: 'string';
  readonly sql: SQL | AnyPgColumn;
  readonly nullable: boolean;
  /** Whether `~` is meaningful (not for a card's last four digits). Default true. */
  readonly substring?: boolean;
}

/** A closed set (`status`, `currency`, `type`): `:` against one of `values`. */
export interface TokenSearchField {
  readonly type: 'token';
  readonly sql: SQL | AnyPgColumn;
  readonly values: readonly string[];
  /** How a value is normalized before it is checked: currencies are uppercase on this wire. */
  readonly case: 'lower' | 'upper';
  readonly nullable: boolean;
}

/** A base-unit integer STRING (CONVENTIONS.md §Money), compared as a number. */
export interface AmountSearchField {
  readonly type: 'amount';
  readonly sql: SQL | AnyPgColumn;
}

/** A `timestamptz` the wire shows as Unix seconds. */
export interface TimestampSearchField {
  readonly type: 'timestamp';
  readonly sql: SQL | AnyPgColumn;
}

export interface BooleanSearchField {
  readonly type: 'boolean';
  readonly sql: SQL | AnyPgColumn;
}

/**
 * Another object, named by its PUBLIC id (`customer:"cus_…"`). The predicate
 * compares the row's INTERNAL key with the key `resolve` looks up inside the
 * caller's merchant — so the row's own index serves it, and an id of another
 * merchant resolves to nothing and matches nothing.
 */
export interface ReferenceSearchField {
  readonly type: 'reference';
  /** The row's internal reference (`payment_intents.customer_id`). */
  readonly sql: SQL | AnyPgColumn;
  /** The public id prefix the value must carry (`cus`). */
  readonly prefix: string;
  /** A scalar subquery answering the internal key of `publicId` in `merchantId`'s scope. */
  readonly resolve: (publicId: string, merchantId: string) => SQL;
  readonly nullable: boolean;
}

/** `metadata['key']:'value'` over a `jsonb` object of strings. */
export interface MetadataSearchField {
  readonly type: 'metadata';
  readonly sql: SQL | AnyPgColumn;
}

export type SearchField =
  | StringSearchField
  | TokenSearchField
  | AmountSearchField
  | TimestampSearchField
  | BooleanSearchField
  | ReferenceSearchField
  | MetadataSearchField;

export type SearchFields = Readonly<Record<string, SearchField>>;

const NUMERIC_OPERATORS: readonly SearchOperator[] = [':', '=', '>', '<', '>=', '<='];

const COMPARISON_SQL: Readonly<Record<'>' | '<' | '>=' | '<=', string>> = {
  '>': '>',
  '<': '<',
  '>=': '>=',
  '<=': '<=',
};

/** The latest instant a timestamp clause may name: 9999-12-31T23:59:59Z. */
const MAX_UNIX_SECONDS = 253_402_300_799n;

export interface CompileContext {
  /** The caller's merchant — every reference resolves inside it. */
  readonly merchantId: string;
  /** For messages: `payment_intents`. */
  readonly resource: string;
}

function fail(message: string, position: number): never {
  throw new SearchQueryError(message, position);
}

function operatorsOf(field: SearchField): readonly SearchOperator[] {
  switch (field.type) {
    case 'string':
      return field.substring === false ? [':'] : [':', '~'];
    case 'amount':
    case 'timestamp':
      return NUMERIC_OPERATORS;
    case 'token':
    case 'boolean':
    case 'reference':
    case 'metadata':
      return [':'];
  }
}

function describeValue(value: SearchValue): string {
  switch (value.kind) {
    case 'string':
      return 'a quoted string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'null':
      return 'null';
  }
}

/** A value that names a string: quoted, or a bare number where text is meant (`metadata['n']:6735`). */
function textOf(clause: SearchClause, name: string, accept: { numbers: boolean }): string {
  const { value } = clause;
  if (value.kind === 'string') return value.value;
  if (value.kind === 'number' && accept.numbers) return value.value;
  return fail(`${name} takes a quoted string, not ${describeValue(value)}`, clause.valuePosition);
}

/** A value that names an integer: bare, or quoted digits (Stripe: quotes are optional for numbers). */
function integerOf(clause: SearchClause, name: string): bigint {
  const { value } = clause;
  if (value.kind === 'number') return BigInt(value.value);
  if (value.kind === 'string' && /^[0-9]{1,30}$/.test(value.value)) return BigInt(value.value);
  return fail(
    `${name} takes a non-negative integer, not ${describeValue(value)}`,
    clause.valuePosition,
  );
}

function nullPredicate(
  expression: SQL | AnyPgColumn,
  nullable: boolean,
  clause: SearchClause,
  name: string,
): SQL {
  if (!nullable) fail(`${name} always has a value; it cannot be null`, clause.valuePosition);
  if (clause.operator !== ':') fail(`null is matched with ':' (${name}:null)`, clause.position);
  return sql`${expression} is null`;
}

function timestampPredicate(expression: SQL | AnyPgColumn, clause: SearchClause, name: string) {
  const seconds = integerOf(clause, name);
  if (seconds > MAX_UNIX_SECONDS) {
    fail(
      `${name} takes Unix seconds; ${seconds.toString()} is too far ahead`,
      clause.valuePosition,
    );
  }
  // The wire floors every instant to its second (`lib/time.ts`), so a row
  // whose `created` reads X was created in [X, X + 1). Each operator is
  // translated against that — `db/keyset.ts` makes the same translation for
  // `created[...]`, so a search and a list agree on which rows a second holds.
  const at = (s: bigint) => sql`to_timestamp(${s.toString()}::bigint)`;
  switch (clause.operator) {
    case ':':
    case '=':
      return sql`(${expression} >= ${at(seconds)} and ${expression} < ${at(seconds + 1n)})`;
    case '>':
      return sql`${expression} >= ${at(seconds + 1n)}`;
    case '>=':
      return sql`${expression} >= ${at(seconds)}`;
    case '<':
      return sql`${expression} < ${at(seconds)}`;
    case '<=':
      return sql`${expression} < ${at(seconds + 1n)}`;
    case '~':
      return fail(`${name} does not take '~'`, clause.position);
  }
}

function amountPredicate(expression: SQL | AnyPgColumn, clause: SearchClause, name: string): SQL {
  const amount = integerOf(clause, name).toString();
  // The column is a canonical base-unit string (a CHECK pins it), so its
  // `numeric` cast is exact — a FAIR amount does not fit a JS number.
  if (clause.operator === ':' || clause.operator === '=') {
    return sql`(${expression})::numeric = ${amount}::numeric`;
  }
  if (clause.operator === '~') return fail(`${name} does not take '~'`, clause.position);
  return sql`(${expression})::numeric ${sql.raw(COMPARISON_SQL[clause.operator])} ${amount}::numeric`;
}

function booleanOf(clause: SearchClause, name: string): boolean {
  const { value } = clause;
  if (value.kind === 'boolean') return value.value;
  if (value.kind === 'string' && (value.value === 'true' || value.value === 'false')) {
    return value.value === 'true';
  }
  return fail(`${name} takes true or false`, clause.valuePosition);
}

function clausePredicate(field: SearchField, clause: SearchClause, context: CompileContext): SQL {
  const name = clause.field;
  if (!operatorsOf(field).includes(clause.operator)) {
    fail(
      `${name} does not take '${clause.operator}'; it takes ${operatorsOf(field)
        .map((op) => `'${op}'`)
        .join(', ')}`,
      clause.position,
    );
  }
  switch (field.type) {
    case 'string': {
      if (clause.value.kind === 'null')
        return nullPredicate(field.sql, field.nullable, clause, name);
      const text = textOf(clause, name, { numbers: false });
      if (clause.operator === '~') {
        if ([...text].length < SEARCH_SUBSTRING_MIN_LENGTH) {
          fail(
            `a substring (~) needs at least ${String(SEARCH_SUBSTRING_MIN_LENGTH)} characters`,
            clause.valuePosition,
          );
        }
        return sql`strpos(lower(${field.sql}), lower(${text}::text)) > 0`;
      }
      return sql`lower(${field.sql}) = lower(${text}::text)`;
    }
    case 'token': {
      if (clause.value.kind === 'null')
        return nullPredicate(field.sql, field.nullable, clause, name);
      const raw = textOf(clause, name, { numbers: false });
      const normalized = field.case === 'upper' ? raw.toUpperCase() : raw.toLowerCase();
      if (!field.values.includes(normalized)) {
        fail(`${name} is one of ${field.values.join(', ')}`, clause.valuePosition);
      }
      return sql`${field.sql} = ${normalized}::text`;
    }
    case 'amount':
      if (clause.value.kind === 'null') return nullPredicate(field.sql, false, clause, name);
      return amountPredicate(field.sql, clause, name);
    case 'timestamp':
      if (clause.value.kind === 'null') return nullPredicate(field.sql, false, clause, name);
      return timestampPredicate(field.sql, clause, name);
    case 'boolean':
      if (clause.value.kind === 'null') return nullPredicate(field.sql, false, clause, name);
      return sql`(${field.sql}) is ${sql.raw(booleanOf(clause, name) ? 'true' : 'false')}`;
    case 'reference': {
      if (clause.value.kind === 'null')
        return nullPredicate(field.sql, field.nullable, clause, name);
      const id = textOf(clause, name, { numbers: false });
      if (!id.startsWith(`${field.prefix}_`)) {
        fail(`${name} takes a ${field.prefix}_… id`, clause.valuePosition);
      }
      return sql`${field.sql} = (${field.resolve(id, context.merchantId)})`;
    }
    case 'metadata': {
      const key = clause.metadataKey;
      if (key === undefined) {
        return fail(`metadata needs a key: metadata['key']:'value'`, clause.position);
      }
      if (clause.value.kind === 'null') return sql`(${field.sql} ->> ${key}::text) is null`;
      const text = textOf(clause, name, { numbers: true });
      // Containment, so a GIN index over the column would serve it unchanged.
      return sql`${field.sql} @> jsonb_build_object(${key}::text, ${text}::text)`;
    }
  }
}

/**
 * Compile `query` against `fields`.
 *
 * @throws {SearchQueryError} a clause names a field the resource does not
 *   have, or gives it an operator or value its type does not take.
 */
export function compileSearch(
  query: SearchQuery,
  fields: SearchFields,
  context: CompileContext,
): SQL {
  const predicates = query.clauses.map((clause) => {
    const field = Object.hasOwn(fields, clause.field) ? fields[clause.field] : undefined;
    if (field === undefined) {
      fail(
        `${context.resource} has no searchable field '${clause.field}'; it has ${Object.keys(fields)
          .sort()
          .join(', ')}`,
        clause.position,
      );
    }
    if (clause.metadataKey !== undefined && field.type !== 'metadata') {
      fail(`only metadata takes a key in brackets`, clause.position);
    }
    const predicate = clausePredicate(field, clause, context);
    // NULL-inclusive negation: `-email:"x"` keeps the customers with no email
    // at all, which `not (lower(email) = 'x')` — NULL for them — would drop.
    return clause.negated ? sql`((${predicate}) is not true)` : sql`(${predicate})`;
  });
  const joined = sql.join(predicates, sql.raw(query.combinator === 'and' ? ' and ' : ' or '));
  return sql`(${joined})`;
}
