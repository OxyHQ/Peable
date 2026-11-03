/**
 * The search query language, exhaustively: every construct, every refusal and
 * the position each refusal names.
 */
import { describe, expect, test } from 'bun:test';
import { SEARCH_QUERY_MAX_CLAUSES, SEARCH_QUERY_MAX_LENGTH } from '@peable.to/shared-types';
import { parseSearchQuery, type SearchQuery, SearchQueryError } from '../parser';

function refusal(query: string): SearchQueryError {
  try {
    parseSearchQuery(query);
  } catch (error) {
    if (error instanceof SearchQueryError) return error;
    throw error;
  }
  throw new Error(`expected '${query}' to be refused`);
}

/** The clauses without their positions, for readable expectations. */
function shape(query: SearchQuery) {
  return {
    combinator: query.combinator,
    clauses: query.clauses.map(({ position: _p, valuePosition: _v, ...rest }) => rest),
  };
}

describe('clauses', () => {
  test('field:"value" with double or single quotes', () => {
    for (const q of ['email:"jenny@example.com"', "email:'jenny@example.com'"]) {
      expect(shape(parseSearchQuery(q))).toEqual({
        combinator: 'and',
        clauses: [
          {
            field: 'email',
            negated: false,
            operator: ':',
            value: { kind: 'string', value: 'jenny@example.com' },
          },
        ],
      });
    }
  });

  test('every operator', () => {
    for (const op of [':', '~', '>', '<', '>=', '<=', '=']) {
      const [clause] = parseSearchQuery(`amount${op}100`).clauses;
      expect(clause?.operator).toBe(op as never);
      expect(clause?.value).toEqual({ kind: 'number', value: '100' });
    }
  });

  test('numbers are canonical; null and booleans are bare words, any case', () => {
    expect(parseSearchQuery('amount>007').clauses[0]?.value).toEqual({
      kind: 'number',
      value: '7',
    });
    expect(parseSearchQuery('customer:NULL').clauses[0]?.value).toEqual({ kind: 'null' });
    expect(parseSearchQuery('active:True').clauses[0]?.value).toEqual({
      kind: 'boolean',
      value: true,
    });
    expect(parseSearchQuery('active:false').clauses[0]?.value).toEqual({
      kind: 'boolean',
      value: false,
    });
  });

  test('dotted fields', () => {
    expect(parseSearchQuery('payment_method_details.card.last4:"4242"').clauses[0]?.field).toBe(
      'payment_method_details.card.last4',
    );
  });

  test('negation', () => {
    const [clause] = parseSearchQuery('-status:"canceled"').clauses;
    expect(clause?.negated).toBe(true);
    expect(clause?.field).toBe('status');
  });

  test("metadata['key'] with either quote, escapes in keys and values", () => {
    expect(shape(parseSearchQuery("metadata['order_id']:'6735'")).clauses[0]).toEqual({
      field: 'metadata',
      metadataKey: 'order_id',
      negated: false,
      operator: ':',
      value: { kind: 'string', value: '6735' },
    });
    const [clause] = parseSearchQuery(`metadata["it's"]:'say \\'hi\\' \\\\ "x"'`).clauses;
    expect(clause?.metadataKey).toBe("it's");
    expect(clause?.value).toEqual({ kind: 'string', value: `say 'hi' \\ "x"` });
    expect(parseSearchQuery('metadata["a b"]:null').clauses[0]?.value).toEqual({ kind: 'null' });
  });

  test('a quoted value keeps every character, including the language’s own', () => {
    const tricky = `a:b AND c OR -d ~ ' ; -- drop table customers; %_`;
    const [clause] = parseSearchQuery(`name:"${tricky}"`).clauses;
    expect(clause?.value).toEqual({ kind: 'string', value: tricky });
  });

  test('positions name where each clause and value start', () => {
    const query = parseSearchQuery('status:"succeeded"  AND -amount>=50');
    expect(query.clauses.map((c) => [c.position, c.valuePosition])).toEqual([
      [0, 7],
      [24, 33],
    ]);
  });
});

describe('combinators', () => {
  test('a space is AND', () => {
    const query = parseSearchQuery('status:"succeeded" currency:"EUR"');
    expect(query.combinator).toBe('and');
    expect(query.clauses).toHaveLength(2);
  });

  test('AND and OR, any case, with any amount of whitespace', () => {
    expect(parseSearchQuery('a:"x" and b:"y" AND c:"z"').combinator).toBe('and');
    expect(parseSearchQuery('a:"x"\tOr\n b:"y" or c:"z"').combinator).toBe('or');
  });

  test('a field that starts like a keyword is a field', () => {
    const query = parseSearchQuery('order:"x" android:"y"');
    expect(query.clauses.map((c) => c.field)).toEqual(['order', 'android']);
  });

  test('AND and OR cannot be combined, and a space is an AND', () => {
    expect(refusal('a:"x" AND b:"y" OR c:"z"').position).toBe(16);
    expect(refusal('a:"x" b:"y" OR c:"z"').position).toBe(12);
    expect(refusal('a:"x" OR b:"y" c:"z"').position).toBe(15);
  });

  test('a dangling keyword', () => {
    expect(refusal('a:"x" AND').message).toContain('expected a clause after AND');
    expect(refusal('a:"x" OR  ').message).toContain('expected a clause after OR');
  });

  test('parentheses are refused, not ignored', () => {
    expect(refusal('(a:"x" OR b:"y")').message).toContain('parentheses are not supported');
  });
});

describe('refusals, each with its position', () => {
  const cases: [string, number, string][] = [
    ['', 0, 'the query is empty'],
    ['   ', 0, 'the query is empty'],
    ['email', 5, 'expected an operator'],
    ['email "x"', 5, 'expected an operator'],
    ['email:', 6, "expected a value after ':'"],
    ['email: "x"', 6, "expected a value after ':'"],
    ['email:jenny@example.com', 6, 'a text value must be quoted'],
    ['email:"jenny', 6, 'unterminated string'],
    ["email:'jenny\\'", 6, 'unterminated string'],
    ['amount>10.5', 7, 'non-negative integer'],
    ['amount>-5', 7, 'non-negative integer'],
    ['amount>1e5', 7, 'a text value must be quoted'],
    ['Email:"x"', 0, 'expected a field name'],
    ['9lives:"x"', 0, 'expected a field name'],
    ['a.:"x"', 2, "expected a field name after '.'"],
    ['-', 1, 'expected a field name'],
    ['status:"a"status:"b"', 10, 'expected a space, AND or OR'],
    ['name["k"]:"v"', 0, 'only metadata takes a key'],
    ['metadata[k]:"v"', 9, 'a metadata key is quoted'],
    ["metadata['k':'v'", 12, "expected ']'"],
    ["metadata['']:'v'", 9, 'a metadata key is 1 to 40'],
    [`metadata['${'k'.repeat(41)}']:'v'`, 9, 'a metadata key is 1 to 40'],
    [`amount>${'9'.repeat(31)}`, 7, 'at most 30 digits'],
  ];
  for (const [query, position, message] of cases) {
    test(JSON.stringify(query), () => {
      const error = refusal(query);
      expect(error.position).toBe(position);
      expect(error.message).toContain(message);
      expect(error.message).toContain(`(at position ${String(position)})`);
    });
  }

  test(`at most ${String(SEARCH_QUERY_MAX_CLAUSES)} clauses`, () => {
    const ten = Array.from({ length: SEARCH_QUERY_MAX_CLAUSES }, (_, i) => `f${i}:"x"`);
    expect(parseSearchQuery(ten.join(' OR ')).clauses).toHaveLength(SEARCH_QUERY_MAX_CLAUSES);
    const eleven = [...ten, 'g:"x"'].join(' OR ');
    const error = refusal(eleven);
    expect(error.message).toContain('at most 10 clauses');
    expect(error.position).toBe(eleven.lastIndexOf('g:'));
  });

  test(`at most ${String(SEARCH_QUERY_MAX_LENGTH)} characters`, () => {
    const long = `name:"${'x'.repeat(SEARCH_QUERY_MAX_LENGTH)}"`;
    expect(refusal(long).message).toContain('at most 1000 characters');
  });
});
