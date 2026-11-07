/**
 * The risk-rule language (ADR 0022 D1): what parses, what is refused and
 * where, and Kleene's three values — including hostile input.
 */
import { describe, expect, test } from 'bun:test';
import { RADAR_LIMITS } from '@peable.to/shared-types';
import { compileRule, type FactValues, RadarRuleError } from '../language';

function refusal(text: string): RadarRuleError {
  try {
    compileRule(text);
  } catch (error) {
    if (error instanceof RadarRuleError) return error;
    throw error;
  }
  throw new Error(`'${text}' compiled`);
}

const card: FactValues = {
  amount: 250_000n,
  currency: 'EUR',
  card_country: 'ES',
  card_brand: 'visa',
  card_funding: 'credit',
  customer: 'cus_1',
  email: 'jenny@example.com',
  payments_per_customer_hourly: 3n,
};

describe('compiling a predicate', () => {
  test('comparisons, lists, like and is_missing', () => {
    const matches = (text: string, facts: FactValues = card) => compileRule(text).matches(facts);
    expect(matches(':amount: > 100000')).toBe(true);
    expect(matches(':amount: >= 250000 and :amount: <= 250000')).toBe(true);
    expect(matches(':amount: < 250000')).toBe(false);
    expect(matches(":currency: = 'eur'")).toBe(true);
    expect(matches(":card_country: not in ('US', 'CA')")).toBe(true);
    expect(matches(":card_country: in ('us', 'es')")).toBe(true);
    expect(matches(":email: like '%@example.com'")).toBe(true);
    expect(matches(":email: like 'j_nny@%'")).toBe(true);
    expect(matches(":email: not like '%@example.org'")).toBe(true);
    expect(matches(":card_brand: != 'amex' and :payments_per_customer_hourly: >= 3")).toBe(true);
    expect(matches('is_missing(:risk_level:)')).toBe(true);
    expect(matches('not is_missing(:customer:)')).toBe(true);
    expect(matches("(:amount: > 1 or :currency: = 'USD') and not :card_funding: = 'debit'")).toBe(
      true,
    );
    expect(matches("NOT (:amount: > 1 AND :currency: = 'EUR')")).toBe(false);
  });

  test('names the facts a predicate reads', () => {
    expect([...compileRule(":amount: > 1 and :email: like '%x'").facts].sort()).toEqual([
      'amount',
      'email',
    ]);
  });

  test('integers are bigint: no float rounding at the edge', () => {
    const rule = compileRule(':amount: > 9007199254740992');
    expect(rule.matches({ amount: 9_007_199_254_740_993n })).toBe(true);
    expect(rule.matches({ amount: 9_007_199_254_740_992n })).toBe(false);
  });
});

describe('an unknown fact never makes a rule match (Kleene)', () => {
  const nothing: FactValues = { amount: 100n };
  test.each([
    ":card_country: = 'US'",
    ":card_country: != 'US'",
    ":card_country: not in ('US')",
    ":risk_level: = 'highest'",
    "not (:risk_level: = 'highest')",
    ':risk_score: > 50',
    'not :risk_score: > 50',
    ":email: not like '%@x'",
    ":card_country: = 'US' or :card_country: != 'US'",
  ])('%s is not TRUE', (text) => {
    expect(compileRule(text).matches(nothing)).toBe(false);
  });

  test('and/or still decide when one side is known', () => {
    expect(compileRule(":risk_level: = 'highest' or :amount: = 100").matches(nothing)).toBe(true);
    expect(compileRule(":risk_level: = 'highest' and :amount: = 1").matches(nothing)).toBe(false);
  });
});

describe('refusals name the position', () => {
  test.each([
    [':nope: > 1', 0, 'unknown fact'],
    [':amount: > 1 and :card_country: = 1', 34, 'compare it with a quoted string'],
    [":amount: = '1'", 11, 'compare it with an integer'],
    [":currency: > 'EUR'", 11, 'compare it with = or !='],
    [':amount: like 1', 9, 'like needs one'],
    [':amount: > 1.5', 12, 'integers only'],
    [':amount: > -1', 11, "unexpected '-'"],
    [':amount: > 1 garbage', 13, 'strings are quoted'],
    [':amount: >', 10, 'expected a value'],
    ["(:currency: = 'EUR'", 19, 'expected ")"'],
    [":currency: = 'EUR", 13, 'unterminated string'],
    [':amount', 0, 'written :name:'],
    [':amount: 5', 9, 'expected =, !='],
    ['', 0, 'empty'],
    [':amount: > 1 :amount: > 2', 13, 'expected "and"'],
  ])('%s', (text, position, reason) => {
    const error = refusal(text);
    expect(error.position).toBe(position);
    expect(error.reason).toContain(reason);
  });
});

describe('hostile input is bounded and never executed', () => {
  test('a predicate longer than the limit', () => {
    expect(refusal(`:amount: > ${'1'.repeat(RADAR_LIMITS.predicateMax)}`).reason).toContain(
      'at most',
    );
  });

  test('deep nesting', () => {
    const deep = `${'('.repeat(RADAR_LIMITS.depthMax + 1)}:amount: > 1${')'.repeat(RADAR_LIMITS.depthMax + 1)}`;
    expect(refusal(deep).reason).toContain('nests at most');
    expect(refusal(`${'not '.repeat(RADAR_LIMITS.depthMax + 1)}:amount: > 1`).reason).toContain(
      'nests at most',
    );
  });

  test('too many conditions', () => {
    const many = Array.from({ length: RADAR_LIMITS.comparisonsMax + 1 }, () => ':amount: > 1').join(
      ' or ',
    );
    expect(refusal(many).reason).toContain('conditions');
  });

  test('a huge list', () => {
    const values = Array.from(
      { length: RADAR_LIMITS.listValuesMax + 1 },
      (_, i) => `'C${String(i)}'`,
    );
    expect(refusal(`:card_country: in (${values.join(',')})`).reason).toContain('at most');
  });

  test('a huge integer and a huge string', () => {
    expect(refusal(`:amount: > ${'9'.repeat(RADAR_LIMITS.integerDigitsMax + 1)}`).reason).toContain(
      'digits',
    );
    expect(refusal(`:email: = '${'x'.repeat(RADAR_LIMITS.stringMax + 1)}'`).reason).toContain(
      'characters',
    );
  });

  test('injection-looking strings are values, compared as text', () => {
    const rule = compileRule(":email: = 'x\\'); drop table radar_rules; --'");
    expect(rule.matches({ email: "x'); drop table radar_rules; --" })).toBe(true);
    expect(rule.matches({ email: 'x' })).toBe(false);
    const quoted = compileRule(":email: = 'a\\'b'");
    expect(quoted.matches({ email: "a'b" })).toBe(true);
    expect(refusal(':amount: > 1; drop table x').reason).toContain("unexpected ';'");
    expect(refusal('constructor').reason).toContain('strings are quoted');
    expect(refusal(':__proto__: = 1').reason).toContain('unknown fact');
    expect(refusal(':constructor: = 1').reason).toContain('unknown fact');
  });

  test('like has no regular-expression meaning', () => {
    const rule = compileRule(":email: like '.*'");
    expect(rule.matches({ email: 'anything' })).toBe(false);
    expect(rule.matches({ email: '.*' })).toBe(true);
    // A pattern that would backtrack catastrophically as a regex stays linear.
    const slow = compileRule(`:email: like '${'%a'.repeat(40)}b'`);
    const started = performance.now();
    expect(slow.matches({ email: 'a'.repeat(190) })).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('a fact the phase cannot know is unknown even to is_missing', () => {
  const noCard = new Set(['card_country', 'risk_level'] as const);
  test('is_missing over an unknowable fact is not TRUE in either polarity', () => {
    expect(compileRule('is_missing(:card_country:)').matches({}, noCard)).toBe(false);
    expect(compileRule('not is_missing(:card_country:)').matches({}, noCard)).toBe(false);
    expect(
      compileRule('is_missing(:risk_level:) or :amount: > 1').matches({ amount: 5n }, noCard),
    ).toBe(true);
  });
  test('a knowable fact that is absent is missing', () => {
    expect(compileRule('is_missing(:customer:)').matches({}, noCard)).toBe(true);
    expect(compileRule('is_missing(:card_country:)').matches({})).toBe(true);
  });
});

describe('like escapes and exact ids', () => {
  test('\\% and \\_ match themselves', () => {
    const percent = compileRule(":email: like '100\\%%'");
    expect(percent.matches({ email: '100%off@x' })).toBe(true);
    expect(percent.matches({ email: '1000@x' })).toBe(false);
    const underscore = compileRule(":email: like 'a\\_b%'");
    expect(underscore.matches({ email: 'a_b@x' })).toBe(true);
    expect(underscore.matches({ email: 'axb@x' })).toBe(false);
  });
  test('a customer id compares exactly; other strings case-insensitively', () => {
    expect(compileRule(":customer: = 'cus_AbC'").matches({ customer: 'cus_AbC' })).toBe(true);
    expect(compileRule(":customer: = 'cus_abc'").matches({ customer: 'cus_AbC' })).toBe(false);
    expect(compileRule(":customer: in ('cus_abc')").matches({ customer: 'cus_AbC' })).toBe(false);
    expect(compileRule(":card_brand: = 'VISA'").matches({ card_brand: 'visa' })).toBe(true);
  });
});
