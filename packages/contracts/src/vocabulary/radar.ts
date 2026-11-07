// Risk rules and reviews (ADR 0022) — the closed value sets their schemas, the
// gateway's evaluator and Orbit's rule editor are built from. Zod-free:
// `@peable.to/shared-types` re-exports them at runtime.

/**
 * What a matching rule does, in Radar's precedence: `allow` beats `block`
 * beats `review` (ADR 0022 D3).
 */
export const RADAR_RULE_ACTIONS = ['allow', 'block', 'review'] as const;
export type RadarRuleAction = (typeof RADAR_RULE_ACTIONS)[number];

/** When a rule set was evaluated: before the provider authorized, or after. */
export const RADAR_EVALUATION_PHASES = ['pre_authorization', 'post_authorization'] as const;
export type RadarEvaluationPhase = (typeof RADAR_EVALUATION_PHASES)[number];

/** Why a review was opened. `manual` is Stripe's and not built (ADR 0022 D5). */
export const REVIEW_OPENED_REASONS = ['rule'] as const;
export type ReviewOpenedReason = (typeof REVIEW_OPENED_REASONS)[number];

/** Why a review was closed — Stripe's, plus `canceled` for a released authorization. */
export const REVIEW_CLOSED_REASONS = [
  'approved',
  'refunded',
  'refunded_as_fraud',
  'canceled',
  'disputed',
] as const;
export type ReviewClosedReason = (typeof REVIEW_CLOSED_REASONS)[number];

/** A review's `reason`: why it is open, or why it closed. */
export const REVIEW_REASONS = [...REVIEW_OPENED_REASONS, ...REVIEW_CLOSED_REASONS] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** How a refused review was refused (`POST /v1/reviews/:id/refuse`). */
export const REVIEW_REFUSAL_REASONS = ['fraudulent', 'requested_by_customer'] as const;
export type ReviewRefusalReason = (typeof REVIEW_REFUSAL_REASONS)[number];

/** The decline code of an attempt a `block` rule refused before authorization. */
export const RADAR_BLOCK_DECLINE_CODE = 'blocked_by_rule';

/** The kinds of value a fact holds. */
export type RadarFactType = 'integer' | 'string';

/**
 * The closed fact registry (ADR 0022 D2): every name a predicate may write as
 * `:name:`, its type, and when it can be known — `preAuthorization`: before
 * the provider authorizes (the card facts only with a saved card);
 * `withoutCard`: before the payer has entered a card at all (handing out the
 * confirmation credential). A fact that cannot be known in a phase is UNKNOWN
 * there, even to `is_missing`. A name not here is a parse error.
 */
export const RADAR_FACTS = {
  amount: { type: 'integer', preAuthorization: true, withoutCard: true },
  currency: { type: 'string', preAuthorization: true, withoutCard: true },
  card_country: { type: 'string', preAuthorization: true, withoutCard: false },
  card_brand: { type: 'string', preAuthorization: true, withoutCard: false },
  card_funding: { type: 'string', preAuthorization: true, withoutCard: false },
  customer: { type: 'string', preAuthorization: true, withoutCard: true },
  email: { type: 'string', preAuthorization: true, withoutCard: true },
  payments_per_customer_hourly: { type: 'integer', preAuthorization: true, withoutCard: true },
  payments_per_customer_daily: { type: 'integer', preAuthorization: true, withoutCard: true },
  payments_per_customer_weekly: { type: 'integer', preAuthorization: true, withoutCard: true },
  amount_per_customer_hourly: { type: 'integer', preAuthorization: true, withoutCard: true },
  amount_per_customer_daily: { type: 'integer', preAuthorization: true, withoutCard: true },
  amount_per_customer_weekly: { type: 'integer', preAuthorization: true, withoutCard: true },
  payments_per_email_hourly: { type: 'integer', preAuthorization: true, withoutCard: true },
  payments_per_email_daily: { type: 'integer', preAuthorization: true, withoutCard: true },
  payments_per_email_weekly: { type: 'integer', preAuthorization: true, withoutCard: true },
  amount_per_email_hourly: { type: 'integer', preAuthorization: true, withoutCard: true },
  amount_per_email_daily: { type: 'integer', preAuthorization: true, withoutCard: true },
  amount_per_email_weekly: { type: 'integer', preAuthorization: true, withoutCard: true },
  risk_level: { type: 'string', preAuthorization: false, withoutCard: false },
  risk_score: { type: 'integer', preAuthorization: false, withoutCard: false },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly type: RadarFactType;
      readonly preAuthorization: boolean;
      readonly withoutCard: boolean;
    }
  >
>;
export type RadarFact = keyof typeof RADAR_FACTS;
export const RADAR_FACT_NAMES = Object.keys(RADAR_FACTS) as readonly RadarFact[];

/** Bounds a rule is checked against (ADR 0022 D1). */
export const RADAR_LIMITS = {
  predicateMax: 1000,
  comparisonsMax: 25,
  depthMax: 8,
  listValuesMax: 50,
  stringMax: 200,
  integerDigitsMax: 30,
  descriptionMax: 500,
  /** Rules per merchant (one mode), enabled or not. */
  rulesPerMerchantMax: 50,
  /** Payments a preview judges, newest first. */
  previewPaymentsMax: 100,
} as const;
