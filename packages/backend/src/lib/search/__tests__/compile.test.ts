/**
 * The compiler, rendered to SQL text and parameters without a database: which
 * operators each type takes, how values are normalized, that every caller value
 * is a bound parameter, and that the merchant reaches every reference subquery.
 * (`routes/__tests__/search.realdb.test.ts` runs the same predicates for real.)
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { boolean, jsonb, PgDialect, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { compileSearch, type SearchFields } from '../compile';
import { parseSearchQuery, SearchQueryError } from '../parser';
import {
  CHARGE_SEARCH_FIELDS,
  CUSTOMER_SEARCH_FIELDS,
  PAYMENT_INTENT_SEARCH_FIELDS,
  PRICE_SEARCH_FIELDS,
  PRODUCT_SEARCH_FIELDS,
  REFUND_SEARCH_FIELDS,
} from '../../../db/search/searchFields';

const things = pgTable('things', {
  id: text().primaryKey(),
  name: text(),
  code: text(),
  status: text().notNull(),
  currency: text().notNull(),
  amount: text().notNull(),
  active: boolean().notNull(),
  ownerId: text(),
  metadata: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
});

const FIELDS: SearchFields = {
  name: { type: 'string', sql: things.name, nullable: true },
  code: { type: 'string', sql: things.code, nullable: true, substring: false },
  status: {
    type: 'token',
    sql: things.status,
    values: ['open', 'closed'],
    case: 'lower',
    nullable: false,
  },
  currency: {
    type: 'token',
    sql: things.currency,
    values: ['EUR', 'USD'],
    case: 'upper',
    nullable: false,
  },
  amount: { type: 'amount', sql: things.amount },
  active: { type: 'boolean', sql: things.active },
  owner: {
    type: 'reference',
    sql: things.ownerId,
    prefix: 'own',
    resolve: (publicId, merchantId) =>
      sql`select o.id from owners o where o.public_id = ${publicId} and o.merchant_id = ${merchantId}`,
    nullable: true,
  },
  created: { type: 'timestamp', sql: things.createdAt },
  metadata: { type: 'metadata', sql: things.metadata },
};

// The application's casing (`@oxy.so/db`'s DATABASE_CASING): camelCase keys, snake_case columns.
const dialect = new PgDialect({ casing: 'snake_case' });
const render = (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
  const { sql: text, params } = dialect.sqlToQuery(query);
  return { sql: text, params };
};
const MERCHANT = 'merchant-internal-id';

function compile(query: string, fields: SearchFields = FIELDS) {
  return render(
    compileSearch(parseSearchQuery(query), fields, { merchantId: MERCHANT, resource: 'things' }),
  );
}

function refusal(query: string, fields: SearchFields = FIELDS): SearchQueryError {
  try {
    compile(query, fields);
  } catch (error) {
    if (error instanceof SearchQueryError) return error;
    throw error;
  }
  throw new Error(`expected '${query}' to be refused`);
}

describe('predicates per type', () => {
  test('string: case-insensitive equality and substring, both bound', () => {
    expect(compile('name:"Jenny"')).toEqual({
      sql: '((lower("things"."name") = lower($1::text)))',
      params: ['Jenny'],
    });
    expect(compile('name~"enn"')).toEqual({
      sql: '((strpos(lower("things"."name"), lower($1::text)) > 0))',
      params: ['enn'],
    });
    expect(compile('name:null').sql).toBe('(("things"."name" is null))');
  });

  test('token: normalized, then checked against its closed set', () => {
    expect(compile('status:"OPEN"')).toEqual({
      sql: '(("things"."status" = $1::text))',
      params: ['open'],
    });
    expect(compile('currency:"eur"').params).toEqual(['EUR']);
    expect(refusal('status:"opne"').message).toContain('status is one of open, closed');
  });

  test('amount: numeric comparison of the base-unit string, quotes optional', () => {
    expect(compile('amount>=1000')).toEqual({
      sql: '((("things"."amount")::numeric >= $1::numeric))',
      params: ['1000'],
    });
    expect(compile('amount:"25"').params).toEqual(['25']);
    expect(compile('amount=99999999999999999999').params).toEqual(['99999999999999999999']);
    expect(refusal('amount>"ten"').message).toContain('non-negative integer');
  });

  test('timestamp: each operator against the floored second', () => {
    const bounds = (query: string) => compile(query);
    expect(bounds('created>100')).toEqual({
      sql: '(("things"."created_at" >= to_timestamp($1::bigint)))',
      params: ['101'],
    });
    expect(bounds('created>=100').params).toEqual(['100']);
    expect(bounds('created<100')).toEqual({
      sql: '(("things"."created_at" < to_timestamp($1::bigint)))',
      params: ['100'],
    });
    expect(bounds('created<=100').params).toEqual(['101']);
    expect(bounds('created:100')).toEqual({
      sql: '((("things"."created_at" >= to_timestamp($1::bigint) and "things"."created_at" < to_timestamp($2::bigint))))',
      params: ['100', '101'],
    });
    expect(refusal('created>999999999999').message).toContain('too far ahead');
  });

  test('boolean: bare or quoted, never a parameter', () => {
    expect(compile('active:true')).toEqual({ sql: '((("things"."active") is true))', params: [] });
    expect(compile("active:'false'").sql).toBe('((("things"."active") is false))');
    expect(refusal('active:"yes"').message).toContain('true or false');
  });

  test('reference: the public id resolved inside the merchant', () => {
    expect(compile('owner:"own_123"')).toEqual({
      sql: '(("things"."owner_id" = (select o.id from owners o where o.public_id = $1 and o.merchant_id = $2)))',
      params: ['own_123', MERCHANT],
    });
    expect(compile('owner:null').sql).toBe('(("things"."owner_id" is null))');
    expect(refusal('owner:"cus_123"').message).toContain('takes a own_… id');
  });

  test('metadata: containment of the key and value, both bound; null is absence', () => {
    expect(compile("metadata['order']:'6735'")).toEqual({
      sql: '(("things"."metadata" @> jsonb_build_object($1::text, $2::text)))',
      params: ['order', '6735'],
    });
    expect(compile("metadata['order']:6735").params).toEqual(['order', '6735']);
    expect(compile("metadata['order']:null")).toEqual({
      sql: '((("things"."metadata" ->> $1::text) is null))',
      params: ['order'],
    });
    expect(refusal('metadata:"x"').message).toContain('metadata needs a key');
  });
});

describe('operators each type refuses', () => {
  const cases: [string, string][] = [
    ['name>"a"', "name does not take '>'"],
    ['code~"424"', "code does not take '~'"],
    ['status~"ope"', "status does not take '~'"],
    ['amount~"10"', "amount does not take '~'"],
    ['active>1', "active does not take '>'"],
    ['owner~"own"', "owner does not take '~'"],
    ["metadata['k']>'v'", "metadata does not take '>'"],
    ['created~"1"', "created does not take '~'"],
  ];
  for (const [query, message] of cases) {
    test(query, () => expect(refusal(query).message).toContain(message));
  }

  test('values of the wrong kind', () => {
    expect(refusal('name:5').message).toContain('name takes a quoted string, not a number');
    expect(refusal('status:null').message).toContain('status always has a value');
    expect(refusal('amount:null').message).toContain('amount always has a value');
    expect(refusal('name~null').message).toContain("null is matched with ':'");
    expect(refusal('name~"ab"').message).toContain('at least 3 characters');
  });

  test('an unknown field names the ones that exist, at its position', () => {
    const error = refusal('name:"a" colour:"red"');
    expect(error.position).toBe(9);
    expect(error.message).toContain("things has no searchable field 'colour'");
    expect(error.message).toContain('active, amount, code, created, currency, metadata, name');
  });

  test('a prototype key is not a field', () => {
    expect(refusal('constructor:"x"').message).toContain("no searchable field 'constructor'");
    expect(refusal('__proto__:"x"').message).toContain("no searchable field '__proto__'");
  });
});

describe('composition', () => {
  test('AND / OR join parenthesized clauses', () => {
    expect(compile('name:"a" OR status:"open"').sql).toBe(
      '((lower("things"."name") = lower($1::text)) or ("things"."status" = $2::text))',
    );
    expect(compile('name:"a" status:"open"').sql).toContain(') and (');
  });

  test('negation is NULL-inclusive', () => {
    expect(compile('-name:"a"').sql).toBe(
      '(((lower("things"."name") = lower($1::text)) is not true))',
    );
  });
});

describe('injection', () => {
  const attacks = [
    `x' OR '1'='1`,
    `x"); drop table customers; --`,
    `'; select pg_sleep(10); --`,
    `%%%`,
    `a_b`,
    `$1 $2`,
    `\\'\\'`,
    `') or true or ('`,
  ];
  const quote = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const shapes = [
    (v: string) => `name:${quote(v)}`,
    (v: string) => `name~${quote(v)}`,
    (v: string) => `metadata[${quote(v)}]:${quote(v)}`,
    (v: string) => `owner:${quote(`own_${v}`)}`,
  ];
  for (const attack of attacks) {
    test(JSON.stringify(attack), () => {
      for (const shape of shapes) {
        const benign = compile(shape('benign'));
        const hostile = compile(shape(attack));
        // The SQL TEXT does not depend on the value at all: the value only ever
        // travels as a parameter, verbatim.
        expect(hostile.sql).toBe(benign.sql);
        expect(hostile.params.some((param) => String(param).includes(attack))).toBe(true);
      }
    });
  }

  test('a field name can never carry SQL: the grammar refuses it first', () => {
    expect(() => compile(`name";drop:"x"`)).toThrow(SearchQueryError);
  });
});

describe('the resource registries', () => {
  const registries = {
    payment_intents: PAYMENT_INTENT_SEARCH_FIELDS,
    charges: CHARGE_SEARCH_FIELDS,
    customers: CUSTOMER_SEARCH_FIELDS,
    products: PRODUCT_SEARCH_FIELDS,
    prices: PRICE_SEARCH_FIELDS,
    refunds: REFUND_SEARCH_FIELDS,
  };

  test('Stripe’s field names are where Stripe has them', () => {
    expect(Object.keys(PAYMENT_INTENT_SEARCH_FIELDS)).toEqual(
      expect.arrayContaining(['amount', 'created', 'currency', 'customer', 'metadata', 'status']),
    );
    expect(Object.keys(CHARGE_SEARCH_FIELDS)).toEqual(
      expect.arrayContaining([
        'amount',
        'billing_details.email',
        'created',
        'currency',
        'customer',
        'disputed',
        'metadata',
        'payment_method_details.card.last4',
        'refunded',
        'status',
      ]),
    );
    expect(Object.keys(CUSTOMER_SEARCH_FIELDS)).toEqual(
      expect.arrayContaining(['created', 'email', 'metadata', 'name', 'phone']),
    );
    expect(Object.keys(PRODUCT_SEARCH_FIELDS)).toEqual(
      expect.arrayContaining(['active', 'created', 'description', 'metadata', 'name']),
    );
    expect(Object.keys(PRICE_SEARCH_FIELDS)).toEqual(
      expect.arrayContaining([
        'active',
        'created',
        'currency',
        'lookup_key',
        'metadata',
        'product',
        'type',
      ]),
    );
  });

  test('every resource takes created and metadata', () => {
    for (const [name, fields] of Object.entries(registries)) {
      const rendered = render(
        compileSearch(parseSearchQuery("created>1 metadata['k']:'v'"), fields, {
          merchantId: MERCHANT,
          resource: name,
        }),
      );
      expect(rendered.params).toEqual(['2', 'k', 'v']);
    }
  });

  test('a reference subquery carries the merchant', () => {
    const rendered = render(
      compileSearch(parseSearchQuery('customer:"cus_1"'), PAYMENT_INTENT_SEARCH_FIELDS, {
        merchantId: MERCHANT,
        resource: 'payment_intents',
      }),
    );
    expect(rendered.params).toEqual(['cus_1', MERCHANT]);
    expect(rendered.sql).toContain('"customers"."merchant_id" =');
  });
});
