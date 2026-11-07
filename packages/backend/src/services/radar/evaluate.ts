/**
 * Judging a card payment against its merchant's risk rules (ADR 0022 D2, D3).
 *
 * Pure decision plus the reads it needs: the enabled rules, the facts those
 * rules name, and Radar's precedence. Acting on the decision (declining an
 * attempt, cancelling an authorization, opening a review) is `gates.ts`'s.
 *
 * FairCoin never reaches a rule: anything but a card-rail payment answers
 * `null` before a single read (ADR 0022 D6).
 */
import { RADAR_FACT_NAMES, RADAR_FACTS } from '@peable.to/shared-types';
import type {
  CardDetails,
  RadarEvaluationPhase,
  RadarFact,
  RadarRuleAction,
} from '@peable.to/shared-types';
import { findCustomerById } from '../../db/customers/customerRepository';
import type { ChargeRow } from '../../db/payments/chargeRepository';
import type { PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import {
  listEnabledRadarRules,
  readVelocity,
  type RadarRuleRow,
  type VelocityWindow,
} from '../../db/radar/radarRepository';
import { compileRule, type CompiledRule, type FactValue, type FactValues } from './language';

/** What the rule set decided, and why. */
export interface RadarDecision {
  readonly action: RadarRuleAction;
  /** The deciding rule — the oldest matching rule of the winning action. */
  readonly rule: RadarRuleRow;
  /** The values of the facts that rule names, as stored on its evaluation. */
  readonly facts: Record<string, string | null>;
}

/** Where the card facts come from in each phase. */
export interface RadarSources {
  /** A saved method's card, before authorization; the charge's after. */
  readonly card?: CardDetails | null;
  /** The charge, after authorization: its provider outcome. */
  readonly charge?: ChargeRow | null;
}

const PRECEDENCE: readonly RadarRuleAction[] = ['allow', 'block', 'review'];

const VELOCITY_FACTS = {
  payments_per_customer_hourly: ['customer', 'hourly', 'count'],
  payments_per_customer_daily: ['customer', 'daily', 'count'],
  payments_per_customer_weekly: ['customer', 'weekly', 'count'],
  amount_per_customer_hourly: ['customer', 'hourly', 'amount'],
  amount_per_customer_daily: ['customer', 'daily', 'amount'],
  amount_per_customer_weekly: ['customer', 'weekly', 'amount'],
  payments_per_email_hourly: ['email', 'hourly', 'count'],
  payments_per_email_daily: ['email', 'daily', 'count'],
  payments_per_email_weekly: ['email', 'weekly', 'count'],
  amount_per_email_hourly: ['email', 'hourly', 'amount'],
  amount_per_email_daily: ['email', 'daily', 'amount'],
  amount_per_email_weekly: ['email', 'weekly', 'amount'],
} as const satisfies Partial<
  Record<RadarFact, readonly ['customer' | 'email', keyof VelocityWindow, 'count' | 'amount']>
>;

function isVelocityFact(fact: RadarFact): fact is keyof typeof VELOCITY_FACTS {
  return Object.hasOwn(VELOCITY_FACTS, fact);
}

const lower = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : value.toLowerCase();

/**
 * Read the facts the named rules need — the velocity statement only when one
 * of them names a velocity fact. Unknown is `null`, never a guess.
 */
export async function gatherFacts(
  db: DatabaseOrTransaction,
  intent: PaymentIntentRow,
  phase: RadarEvaluationPhase,
  sources: RadarSources,
  needed: ReadonlySet<RadarFact>,
): Promise<FactValues> {
  const card = sources.card ?? sources.charge?.paymentMethodDetails?.card ?? null;
  const facts: Partial<Record<RadarFact, FactValue>> = {
    amount: BigInt(intent.amount),
    currency: intent.currency,
    card_country: card?.country ?? null,
    card_brand: lower(card?.brand),
    card_funding: lower(card?.funding),
    customer: intent.customerPublicId,
    risk_level: null,
    risk_score: null,
  };
  if (phase === 'post_authorization') {
    const outcome = sources.charge?.outcome ?? null;
    facts.risk_level = lower(outcome?.riskLevel);
    const score = outcome?.riskScore;
    facts.risk_score = typeof score === 'number' && Number.isInteger(score) ? BigInt(score) : null;
  }

  const wantsEmail = [...needed].some(
    (fact) => fact === 'email' || (isVelocityFact(fact) && VELOCITY_FACTS[fact][0] === 'email'),
  );
  let email: string | null = null;
  if (wantsEmail) {
    const customer =
      intent.customerId === null ? null : await findCustomerById(db, intent.customerId);
    email = lower(customer?.email ?? intent.receiptEmail);
  }
  facts.email = email;

  const velocity = [...needed].filter(isVelocityFact);
  if (velocity.length > 0) {
    const read = await readVelocity(db, {
      merchantId: intent.merchantId,
      excludeIntentId: intent.id,
      currency: intent.currency,
      customerId: velocity.some((fact) => VELOCITY_FACTS[fact][0] === 'customer')
        ? intent.customerId
        : null,
      email: velocity.some((fact) => VELOCITY_FACTS[fact][0] === 'email') ? email : null,
    });
    for (const fact of velocity) {
      const [subject, window, measure] = VELOCITY_FACTS[fact];
      const windows = subject === 'customer' ? read.customer : read.email;
      facts[fact] = windows === null ? null : windows[window][measure];
    }
  }
  return facts;
}

function factRecord(rule: CompiledRule, facts: FactValues): Record<string, string | null> {
  const record: Record<string, string | null> = {};
  for (const fact of [...rule.facts].sort()) {
    const value = facts[fact] ?? null;
    record[fact] = value === null ? null : String(value);
  }
  return record;
}

/** Radar's precedence over the rules that matched, oldest first within an action. */
export function decide(
  rules: readonly { readonly row: RadarRuleRow; readonly compiled: CompiledRule }[],
  facts: FactValues,
  unknowable: ReadonlySet<RadarFact> = new Set(),
): RadarDecision | null {
  const matched = rules.filter((rule) => rule.compiled.matches(facts, unknowable));
  for (const action of PRECEDENCE) {
    const winner = matched.find((rule) => rule.row.action === action);
    if (winner) {
      return { action, rule: winner.row, facts: factRecord(winner.compiled, facts) };
    }
  }
  return null;
}

/** Compile stored rules; one that no longer compiles is skipped, never guessed at. */
export function compileRules(
  rows: readonly RadarRuleRow[],
): { readonly row: RadarRuleRow; readonly compiled: CompiledRule }[] {
  const compiled: { row: RadarRuleRow; compiled: CompiledRule }[] = [];
  for (const row of rows) {
    try {
      compiled.push({ row, compiled: compileRule(row.predicate) });
    } catch (error) {
      console.error(
        `[radar] rule ${row.publicId} v${String(row.version)} no longer compiles`,
        error,
      );
    }
  }
  return compiled;
}

/**
 * Judge one card payment in one phase. `null`: not a card payment, no enabled
 * rule, or nothing matched.
 */
export async function evaluateRules(
  intent: PaymentIntentRow,
  phase: RadarEvaluationPhase,
  sources: RadarSources,
): Promise<RadarDecision | null> {
  if (intent.rail !== 'card') return null;
  const db = getDb();
  const rules = compileRules(await listEnabledRadarRules(db, intent.merchantId));
  if (rules.length === 0) return null;
  const needed = new Set<RadarFact>();
  for (const rule of rules) for (const fact of rule.compiled.facts) needed.add(fact);
  const facts = await gatherFacts(db, intent, phase, sources, needed);
  return decide(rules, facts, unknowableIn(phase, sources));
}

/**
 * The facts a phase cannot know (ADR 0022 D1): before authorization, the
 * provider's risk; before the payer entered a card (no saved card, no
 * charge), the card too. UNKNOWN there even to `is_missing`, so
 * `block if is_missing(:card_country:)` cannot decline every payer.
 */
export function unknowableIn(
  phase: RadarEvaluationPhase,
  sources: RadarSources,
): ReadonlySet<RadarFact> {
  if (phase === 'post_authorization') return new Set();
  const withCard = (sources.card ?? sources.charge?.paymentMethodDetails?.card ?? null) !== null;
  return new Set(
    RADAR_FACT_NAMES.filter((fact) =>
      withCard ? !RADAR_FACTS[fact].preAuthorization : !RADAR_FACTS[fact].withoutCard,
    ),
  );
}
