// Subscriptions (ADR 0018 §1) — the closed value sets their schemas are built
// from. Zod-free: `@peable.to/shared-types` re-exports them at runtime.

/**
 * Where a subscription stands — Stripe's eight.
 *
 *  - `incomplete`          — the first invoice is not paid yet; expires to
 *                            `incomplete_expired` when nobody pays it in time.
 *  - `incomplete_expired`  — terminal: the first invoice was never paid.
 *  - `trialing`            — in a trial; nothing is charged until it ends.
 *  - `active`              — in good standing.
 *  - `past_due`            — a renewal invoice failed; dunning is retrying it.
 *  - `unpaid`              — dunning gave up and the merchant's final action
 *                            is `unpaid`: invoices are still created, access
 *                            should be withdrawn.
 *  - `canceled`            — terminal.
 *  - `paused`              — a trial ended with no payment method and the
 *                            trial's end behaviour was `pause`; resumed with
 *                            `POST /v1/subscriptions/:id/resume`.
 */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** `status=` on a subscription list: a status, `all` (including canceled), or `ended`. */
export const SUBSCRIPTION_LIST_STATUSES = [...SUBSCRIPTION_STATUSES, 'all', 'ended'] as const;
export type SubscriptionListStatus = (typeof SUBSCRIPTION_LIST_STATUSES)[number];

/** How the subscription's invoices are collected. FairCoin is always `send_invoice`. */
export const COLLECTION_METHODS = ['charge_automatically', 'send_invoice'] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

/** How a change mid-period is billed. */
export const PRORATION_BEHAVIORS = ['create_prorations', 'none', 'always_invoice'] as const;
export type ProrationBehavior = (typeof PRORATION_BEHAVIORS)[number];

/** The proration behaviours a subscription CREATE accepts: there is nothing to invoice at once yet. */
export const CREATE_PRORATION_BEHAVIORS = [
  'create_prorations',
  'none',
] as const satisfies readonly ProrationBehavior[];

/** What a create does when the first invoice cannot be paid at once. */
export const PAYMENT_BEHAVIORS = [
  'allow_incomplete',
  'default_incomplete',
  'error_if_incomplete',
] as const;
export type PaymentBehavior = (typeof PAYMENT_BEHAVIORS)[number];

/** What happens to the invoices of a subscription whose collection is paused. */
export const PAUSE_COLLECTION_BEHAVIORS = ['keep_as_draft', 'mark_uncollectible', 'void'] as const;
export type PauseCollectionBehavior = (typeof PAUSE_COLLECTION_BEHAVIORS)[number];

/** What a trial ending with no payment method does (`trial_settings.end_behavior`). */
export const TRIAL_END_BEHAVIORS = ['cancel', 'create_invoice', 'pause'] as const;
export type TrialEndBehavior = (typeof TRIAL_END_BEHAVIORS)[number];

/** Why a subscription was cancelled. */
export const SUBSCRIPTION_CANCELLATION_REASONS = [
  'cancellation_requested',
  'payment_failed',
] as const;
export type SubscriptionCancellationReason = (typeof SUBSCRIPTION_CANCELLATION_REASONS)[number];

/** `billing_cycle_anchor` on a resume: a new period now (the default), or the anchor kept. */
export const RESUME_BILLING_CYCLE_ANCHORS = ['now', 'unchanged'] as const;
export type ResumeBillingCycleAnchor = (typeof RESUME_BILLING_CYCLE_ANCHORS)[number];
