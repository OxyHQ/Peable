import { describe, expect, it } from 'bun:test';
import {
  RADAR_FACT_NAMES as SHARED_FACT_NAMES,
  RADAR_FACTS as SHARED_FACTS,
  RADAR_LIMITS as SHARED_LIMITS,
  RADAR_RULE_ACTIONS as SHARED_ACTIONS,
  type RadarRule,
} from '@peable.to/shared-types';
import { OrbitApiError } from '../api/transport';
import {
  buildCreateRuleBody,
  buildUpdateRuleBody,
  changesVersion,
  EMPTY_RULE_FORM,
  factAvailability,
  parsePredicateRefusal,
  predicateStatus,
  RADAR_FACT_NAMES,
  RADAR_LIMITS,
  RADAR_RULE_ACTIONS,
  type RuleForm,
  ruleFormOf,
  ruleSaveFailure,
  ruleTiming,
  ruleUnchanged,
  splitAtPosition,
  timingNoteKeys,
} from './ruleForm';
import { RADAR_EN, RADAR_ES } from './strings';

const rule: RadarRule = {
  id: 'rule_1',
  object: 'radar.rule',
  livemode: false,
  action: 'block',
  predicate: ':amount: > 100000',
  description: 'Large payments',
  enabled: true,
  version: 3,
  created: 1_800_000_000,
  updated: 1_800_000_100,
};

const form = (overrides: Partial<RuleForm> = {}): RuleForm => ({
  ...ruleFormOf(rule),
  ...overrides,
});

describe('the vocabulary', () => {
  it('is the one shared-types re-exports (the gateway judges with the same registry)', () => {
    expect(RADAR_RULE_ACTIONS).toEqual(SHARED_ACTIONS);
    expect(RADAR_FACT_NAMES).toEqual(SHARED_FACT_NAMES);
    expect(RADAR_LIMITS).toEqual(SHARED_LIMITS);
    for (const fact of RADAR_FACT_NAMES) expect(SHARED_FACTS[fact]).toBeDefined();
  });
});

describe('the request bodies', () => {
  it('creates with the trimmed predicate, the description only when given, and the switch', () => {
    expect(
      buildCreateRuleBody({
        action: 'review',
        predicate: "  :card_country: = 'US'  ",
        description: '  ',
        enabled: false,
      }),
    ).toEqual({
      ok: true,
      body: { action: 'review', predicate: ":card_country: = 'US'", enabled: false },
    });
    expect(
      buildCreateRuleBody({ ...EMPTY_RULE_FORM, predicate: ':amount: > 1', description: 'x' }),
    ).toEqual({
      ok: true,
      body: { action: 'block', predicate: ':amount: > 1', description: 'x', enabled: true },
    });
  });

  it('refuses an empty or oversized predicate and an oversized description before asking', () => {
    expect(buildCreateRuleBody(EMPTY_RULE_FORM)).toEqual({
      ok: false,
      errors: { predicate: 'required' },
    });
    expect(
      buildCreateRuleBody({
        ...EMPTY_RULE_FORM,
        predicate: 'x'.repeat(RADAR_LIMITS.predicateMax + 1),
        description: 'y'.repeat(RADAR_LIMITS.descriptionMax + 1),
      }),
    ).toEqual({ ok: false, errors: { predicate: 'too_long', description: 'too_long' } });
  });

  it('updates only what changed, and clears a description with an empty string', () => {
    expect(buildUpdateRuleBody(rule, form())).toEqual({ ok: true, body: {} });
    expect(buildUpdateRuleBody(rule, form({ enabled: false, description: '' }))).toEqual({
      ok: true,
      body: { description: '', enabled: false },
    });
    expect(
      buildUpdateRuleBody(rule, form({ action: 'review', predicate: ' :amount: > 5 ' })),
    ).toEqual({ ok: true, body: { action: 'review', predicate: ':amount: > 5' } });
  });

  it('knows when a save would make a new version, and when there is nothing to save', () => {
    expect(ruleUnchanged(rule, form())).toBe(true);
    expect(ruleUnchanged(rule, form({ predicate: `${rule.predicate}  ` }))).toBe(true);
    expect(changesVersion(rule, form({ enabled: false }))).toBe(false);
    expect(changesVersion(rule, form({ description: 'Other' }))).toBe(false);
    expect(changesVersion(rule, form({ action: 'allow' }))).toBe(true);
    expect(changesVersion(rule, form({ predicate: ':amount: > 1' }))).toBe(true);
  });
});

describe("the gateway's refusals", () => {
  it('reads the reason and the 0-based position of a predicate that does not parse', () => {
    expect(parsePredicateRefusal("predicate: unknown fact 'card_colour' (at position 1)")).toEqual({
      message: "unknown fact 'card_colour'",
      position: 1,
    });
    expect(parsePredicateRefusal('predicate: too many comparisons')).toEqual({
      message: 'too many comparisons',
      position: null,
    });
  });

  it('marks the predicate, names the limit, or leaves the refusal to a toast', () => {
    const refusal = (init: { status: number; code?: string; param?: string; message: string }) =>
      new OrbitApiError({ type: 'invalid_request_error', requestId: 'req_1', ...init });
    expect(
      ruleSaveFailure(
        refusal({
          status: 400,
          code: 'parameter_invalid',
          param: 'predicate',
          message: 'predicate: expected a value (at position 10)',
        }),
      ),
    ).toEqual({
      kind: 'predicate',
      problem: { message: 'expected a value', position: 10 },
    });
    expect(
      ruleSaveFailure(refusal({ status: 409, code: 'rule_limit_reached', message: 'Too many.' })),
    ).toEqual({ kind: 'limit' });
    expect(
      ruleSaveFailure(refusal({ status: 400, param: 'description', message: 'too long' })),
    ).toEqual({ kind: 'field', field: 'description' });
    expect(ruleSaveFailure(refusal({ status: 503, message: 'down' }))).toEqual({ kind: 'other' });
    expect(ruleSaveFailure(new TypeError('offline'))).toEqual({ kind: 'other' });
  });

  it('points at the character the gateway stopped at, or past the end', () => {
    expect(splitAtPosition(':amount: >', 9)).toEqual({ before: ':amount: ', at: '>', after: '' });
    expect(splitAtPosition(':amount: >', 10)).toEqual({ before: ':amount: >', at: '', after: '' });
    expect(splitAtPosition('abc', 99).before).toBe('abc');
    expect(splitAtPosition('abc', -1)).toEqual({ before: '', at: 'a', after: 'bc' });
  });
});

describe('live validation', () => {
  const valid = {
    valid: true as const,
    facts: ['amount', 'risk_level'],
    post_authorization_only: true,
    saved_card_only: false,
  };

  it('is empty, then checking until the answer is for the text in the field', () => {
    expect(predicateStatus({ typed: '  ', checked: '', answer: undefined, failed: false })).toEqual(
      {
        kind: 'empty',
      },
    );
    expect(
      predicateStatus({
        typed: ':amount: > 2',
        checked: ':amount: > 1',
        answer: valid,
        failed: false,
      }),
    ).toEqual({ kind: 'checking' });
    expect(
      predicateStatus({
        typed: ':amount: > 2',
        checked: ':amount: > 2',
        answer: undefined,
        failed: false,
      }),
    ).toEqual({ kind: 'checking' });
  });

  it("shows the gateway's verdict, with its facts and timing", () => {
    expect(predicateStatus({ typed: 'x', checked: 'x', answer: valid, failed: false })).toEqual({
      kind: 'valid',
      facts: ['amount', 'risk_level'],
      postAuthorizationOnly: true,
    });
    expect(
      predicateStatus({
        typed: ':amount >',
        checked: ':amount >',
        answer: { valid: false, message: "expected ':'", position: 7 },
        failed: false,
      }),
    ).toEqual({ kind: 'invalid', problem: { message: "expected ':'", position: 7 } });
  });

  it('says it could not check, rather than calling a condition valid or invalid', () => {
    expect(predicateStatus({ typed: 'x', checked: 'x', answer: undefined, failed: true })).toEqual({
      kind: 'unchecked',
    });
  });

  it('refuses an oversized predicate without asking', () => {
    const long = 'x'.repeat(RADAR_LIMITS.predicateMax + 1);
    expect(predicateStatus({ typed: long, checked: long, answer: valid, failed: false }).kind).toBe(
      'invalid',
    );
  });
});

describe('when a rule can act', () => {
  it('knows each fact: the payment’s before, a card’s with a saved card, the outcome after', () => {
    expect(factAvailability('amount')).toBe('before');
    expect(factAvailability('payments_per_email_daily')).toBe('before');
    expect(factAvailability('card_country')).toBe('card');
    expect(factAvailability('risk_level')).toBe('after');
    expect(factAvailability('risk_score')).toBe('after');
  });

  it('takes the latest fact a rule reads, and the gateway’s post_authorization_only', () => {
    expect(ruleTiming(['amount', 'currency'], false)).toBe('before');
    expect(ruleTiming(['amount', 'card_country'], false)).toBe('card');
    expect(ruleTiming(['card_country', 'risk_score'], false)).toBe('after');
    expect(ruleTiming([], true)).toBe('after');
  });

  it('warns that a block after authorization becomes a review on automatic capture', () => {
    expect(timingNoteKeys('block', 'before')).toEqual([
      'radar.timing.before',
      'radar.consequence.blockBefore',
    ]);
    expect(timingNoteKeys('block', 'card')).toEqual([
      'radar.timing.card',
      'radar.consequence.blockAfter',
    ]);
    expect(timingNoteKeys('block', 'after')).toEqual([
      'radar.timing.after',
      'radar.consequence.blockAfter',
    ]);
    expect(timingNoteKeys('review', 'before')[1]).toBe('radar.consequence.review');
    expect(timingNoteKeys('allow', 'after')[1]).toBe('radar.consequence.allow');
  });
});

describe('the words', () => {
  it('spell every key the editor builds at run time, in both languages', () => {
    const keys = [
      ...RADAR_RULE_ACTIONS.flatMap((action) => [
        `radar.action.${action}`,
        `radar.actionHelp.${action}`,
        `radar.decision.${action}`,
        ...(['before', 'card', 'after'] as const).flatMap((timing) =>
          timingNoteKeys(action, timing),
        ),
      ]),
      ...RADAR_FACT_NAMES.map((fact) => `radar.availability.${factAvailability(fact)}`),
      'radar.factType.integer',
      'radar.factType.string',
      'radar.phase.pre_authorization',
      'radar.phase.post_authorization',
      'radar.error.required',
      'radar.error.too_long',
      'radar.error.server',
    ];
    for (const key of keys) {
      expect({ key, en: Object.hasOwn(RADAR_EN, key) }).toEqual({ key, en: true });
      expect({ key, es: Object.hasOwn(RADAR_ES, key) }).toEqual({ key, es: true });
    }
  });
});
