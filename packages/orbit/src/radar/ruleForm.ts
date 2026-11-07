import {
  RADAR_FACT_NAMES,
  RADAR_FACTS,
  RADAR_LIMITS,
  RADAR_RULE_ACTIONS,
  type RadarFact,
  type RadarRuleAction,
} from '@peable.to/contracts/vocabulary';
import type {
  CreateRadarRuleParams,
  RadarRule,
  UpdateRadarRuleParams,
} from '@peable.to/shared-types';
import { isOrbitApiError } from '../api/transport';
import type { RiskPredicateCheck } from '../api/dashboard';

/**
 * The risk rule editor as pure data (ADR 0022): the form a screen edits, the
 * exact request bodies, what the gateway's refusals mean for each field, and
 * WHEN a rule can act — before authorization, or only after it.
 *
 * The value sets come from `@peable.to/contracts/vocabulary` (zod-free, what
 * the gateway judges with): the `@peable.to/shared-types` root barrel also
 * exports the `node:crypto` webhook signer, which a browser bundle cannot load.
 */

export { RADAR_FACT_NAMES, RADAR_LIMITS, RADAR_RULE_ACTIONS };
export type { RadarFact, RadarRuleAction };

export interface RuleForm {
  action: RadarRuleAction;
  predicate: string;
  description: string;
  enabled: boolean;
}

export const EMPTY_RULE_FORM: RuleForm = {
  action: 'block',
  predicate: '',
  description: '',
  enabled: true,
};

export function ruleFormOf(rule: RadarRule): RuleForm {
  return {
    action: rule.action,
    predicate: rule.predicate,
    description: rule.description ?? '',
    enabled: rule.enabled,
  };
}

export type RuleField = 'predicate' | 'description';
export type RuleFormErrorCode = 'required' | 'too_long' | 'server';
export type RuleFormErrors = Partial<Record<RuleField, RuleFormErrorCode>>;

export type BuildResult<T> = { ok: true; body: T } | { ok: false; errors: RuleFormErrors };

function check(form: RuleForm): RuleFormErrors {
  const errors: RuleFormErrors = {};
  const predicate = form.predicate.trim();
  if (!predicate) errors.predicate = 'required';
  else if (predicate.length > RADAR_LIMITS.predicateMax) errors.predicate = 'too_long';
  if (form.description.trim().length > RADAR_LIMITS.descriptionMax) errors.description = 'too_long';
  return errors;
}

export function buildCreateRuleBody(form: RuleForm): BuildResult<CreateRadarRuleParams> {
  const errors = check(form);
  if (Object.keys(errors).length) return { ok: false, errors };
  const description = form.description.trim();
  return {
    ok: true,
    body: {
      action: form.action,
      predicate: form.predicate.trim(),
      ...(description ? { description } : {}),
      enabled: form.enabled,
    },
  };
}

/**
 * Only what changed: a new `action` or `predicate` is a new version, so an
 * unchanged one is never sent. An emptied description is `''`, which clears it.
 */
export function buildUpdateRuleBody(
  rule: RadarRule,
  form: RuleForm,
): BuildResult<UpdateRadarRuleParams> {
  const errors = check(form);
  if (Object.keys(errors).length) return { ok: false, errors };
  const body: UpdateRadarRuleParams = {};
  const predicate = form.predicate.trim();
  const description = form.description.trim();
  if (form.action !== rule.action) body.action = form.action;
  if (predicate !== rule.predicate) body.predicate = predicate;
  if (description !== (rule.description ?? '')) body.description = description;
  if (form.enabled !== rule.enabled) body.enabled = form.enabled;
  return { ok: true, body };
}

/** Whether the form says exactly what the rule already says: nothing to save. */
export function ruleUnchanged(rule: RadarRule, form: RuleForm): boolean {
  const built = buildUpdateRuleBody(rule, form);
  return built.ok && Object.keys(built.body).length === 0;
}

/** Whether saving would change the version (the action or the predicate moves). */
export function changesVersion(rule: RadarRule, form: RuleForm): boolean {
  return form.action !== rule.action || form.predicate.trim() !== rule.predicate;
}

// ---- The gateway's refusals ------------------------------------------------------------

/** Where a predicate stopped parsing: the gateway's reason and its 0-based position. */
export interface PredicateProblem {
  message: string;
  position: number | null;
}

const PREDICATE_REFUSAL = /^(?:predicate:\s*)?([\s\S]*?)(?:\s*\(at position (\d+)\))?$/;

/** `predicate: <reason> (at position N)` → the reason and N. */
export function parsePredicateRefusal(message: string): PredicateProblem {
  const match = PREDICATE_REFUSAL.exec(message.trim());
  const reason = match?.[1]?.trim() || message;
  const position = match?.[2] === undefined ? null : Number(match[2]);
  return { message: reason, position };
}

/**
 * What a failed save means for the form: a predicate the gateway could not
 * parse marks the predicate with the gateway's words and position; the 51st
 * rule is the limit; anything else is not a field's (the caller toasts it).
 */
export type RuleSaveFailure =
  | { kind: 'predicate'; problem: PredicateProblem }
  | { kind: 'field'; field: RuleField }
  | { kind: 'limit' }
  | { kind: 'other' };

export function ruleSaveFailure(error: unknown): RuleSaveFailure {
  if (!isOrbitApiError(error)) return { kind: 'other' };
  if (error.code === 'rule_limit_reached') return { kind: 'limit' };
  if (error.status === 400 && error.param === 'predicate') {
    return { kind: 'predicate', problem: parsePredicateRefusal(error.message) };
  }
  if (error.status === 400 && error.param === 'description') {
    return { kind: 'field', field: 'description' };
  }
  return { kind: 'other' };
}

/** The predicate split around the position the gateway named, to point at it. */
export function splitAtPosition(
  predicate: string,
  position: number,
): { before: string; at: string; after: string } {
  const at = Math.max(0, Math.min(position, predicate.length));
  return {
    before: predicate.slice(0, at),
    at: predicate.slice(at, at + 1),
    after: predicate.slice(at + 1),
  };
}

// ---- Live validation -------------------------------------------------------------------

/** What the editor says under the predicate while it is typed. */
export type PredicateStatus =
  | { kind: 'empty' }
  | { kind: 'checking' }
  | { kind: 'valid'; facts: RadarFact[]; postAuthorizationOnly: boolean }
  | { kind: 'invalid'; problem: PredicateProblem }
  | { kind: 'unchecked' };

/**
 * The status from the typed text, the debounced text that was sent, and the
 * gateway's answer for it. An answer for older text is never shown as the
 * answer for what is in the field now.
 */
export function predicateStatus(input: {
  typed: string;
  checked: string;
  answer: RiskPredicateCheck | undefined;
  failed: boolean;
}): PredicateStatus {
  const typed = input.typed.trim();
  if (!typed) return { kind: 'empty' };
  if (typed.length > RADAR_LIMITS.predicateMax) {
    return {
      kind: 'invalid',
      problem: { message: `longer than ${RADAR_LIMITS.predicateMax} characters`, position: null },
    };
  }
  if (input.checked.trim() !== typed) return { kind: 'checking' };
  if (input.failed) return { kind: 'unchecked' };
  if (!input.answer) return { kind: 'checking' };
  if (!input.answer.valid) {
    return {
      kind: 'invalid',
      problem: { message: input.answer.message, position: input.answer.position },
    };
  }
  return {
    kind: 'valid',
    facts: input.answer.facts.filter(isRadarFact),
    postAuthorizationOnly: input.answer.post_authorization_only,
  };
}

export function isRadarFact(name: string): name is RadarFact {
  return Object.hasOwn(RADAR_FACTS, name);
}

// ---- When a rule can act ---------------------------------------------------------------

/**
 * When a fact is known (ADR 0022 D2): the payment's own facts before
 * authorization; a card's only with a saved card confirmed from the server
 * (a payer confirming in the checkout enters it after); the provider's risk
 * outcome only after authorization.
 */
export type FactAvailability = 'before' | 'card' | 'after';

export function factAvailability(fact: RadarFact): FactAvailability {
  if (!RADAR_FACTS[fact].preAuthorization) return 'after';
  if (!RADAR_FACTS[fact].withoutCard) return 'card';
  return 'before';
}

export function factType(fact: RadarFact): 'integer' | 'string' {
  return RADAR_FACTS[fact].type;
}

/**
 * When a rule over these facts can act: `before` authorization always, only
 * with a saved `card` (otherwise after), or only `after` (the provider's
 * outcome) — `post_authorization_only` is the gateway's word for the last.
 */
export type RuleTiming = 'before' | 'card' | 'after';

export function ruleTiming(
  facts: readonly RadarFact[],
  postAuthorizationOnly: boolean,
): RuleTiming {
  if (postAuthorizationOnly || facts.some((fact) => factAvailability(fact) === 'after')) {
    return 'after';
  }
  if (facts.some((fact) => factAvailability(fact) === 'card')) return 'card';
  return 'before';
}

/**
 * The notes the editor shows for an action at a timing — the i18n keys, in
 * order. The one a merchant must not miss: a `block` that can only act after
 * authorization cannot stop an automatically captured payment; it opens a
 * review instead (manual capture releases the authorization).
 */
export function timingNoteKeys(action: RadarRuleAction, timing: RuleTiming): string[] {
  const keys = [`radar.timing.${timing}`];
  if (action === 'block') {
    keys.push(
      timing === 'before' ? 'radar.consequence.blockBefore' : 'radar.consequence.blockAfter',
    );
  } else if (action === 'review') {
    keys.push('radar.consequence.review');
  } else {
    keys.push('radar.consequence.allow');
  }
  return keys;
}
