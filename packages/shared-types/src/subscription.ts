// Subscriptions (`sub_…`) and their items (`si_…`) — Orbit's native billing
// engine (ADR 0018). Stripe's object model on Peable's wire (ADR 0014 D1):
// snake_case, Unix seconds, `livemode`, every amount a base-unit STRING.
import type { Coupon, Price, PromotionCode } from './catalog';
import type { Customer } from './customer';
import type { ListParams, RangeQuery } from './list';
import type { CurrencyCode } from './money';
import type { PaymentMethod } from './paymentMethod';
import type { Invoice } from './invoice';

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

/**
 * The statuses that grant access — what active entitlements are computed from
 * (ADR 0018 §6).
 */
export const SUBSCRIPTION_ENTITLED_STATUSES = [
  'trialing',
  'active',
  'past_due',
] as const satisfies readonly SubscriptionStatus[];

/** How the subscription's invoices are collected. FairCoin is always `send_invoice`. */
export const COLLECTION_METHODS = ['charge_automatically', 'send_invoice'] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

/** How a change mid-period is billed. */
export const PRORATION_BEHAVIORS = ['create_prorations', 'none', 'always_invoice'] as const;
export type ProrationBehavior = (typeof PRORATION_BEHAVIORS)[number];

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

/** A discount applied to a subscription or an invoice. */
export interface Discount {
  object: 'discount';
  /** The coupon — its id, or the Coupon when expanded. */
  coupon: string | Coupon;
  promotion_code: string | PromotionCode | null;
  /** When it started applying. */
  start: number;
  /** When it stops (a `repeating` coupon); `null` for `once` and `forever`. */
  end: number | null;
}

/** One line of a subscription: a price and a quantity. */
export interface SubscriptionItem {
  id: string;
  object: 'subscription_item';
  livemode: boolean;
  subscription: string;
  /** The Price, always expanded (Stripe's shape). */
  price: Price;
  quantity: number;
  metadata: Record<string, string>;
  created: number;
}

/** What `DELETE /v1/subscription_items/:id` answers. */
export interface DeletedSubscriptionItem {
  id: string;
  object: 'subscription_item';
  deleted: true;
}

export interface Subscription {
  id: string;
  object: 'subscription';
  livemode: boolean;
  customer: string | Customer;
  status: SubscriptionStatus;
  currency: CurrencyCode;
  items: { object: 'list'; data: SubscriptionItem[]; has_more: boolean; url: string };
  collection_method: CollectionMethod;
  /** `send_invoice` only: days from finalization to the invoice's due date. */
  days_until_due: number | null;
  default_payment_method: string | PaymentMethod | null;
  description: string | null;
  billing_cycle_anchor: number;
  current_period_start: number;
  current_period_end: number;
  start_date: number;
  trial_start: number | null;
  trial_end: number | null;
  trial_settings: { end_behavior: { missing_payment_method: TrialEndBehavior } };
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  cancellation_details: {
    reason: SubscriptionCancellationReason | null;
    comment: string | null;
  };
  pause_collection: { behavior: PauseCollectionBehavior; resumes_at: number | null } | null;
  automatic_tax: { enabled: boolean };
  discount: Discount | null;
  latest_invoice: string | Invoice | null;
  /** The test clock (`clock_…`) the customer is attached to; test mode only. */
  test_clock: string | null;
  metadata: Record<string, string>;
  created: number;
}

/** A subscription item as `items[]` of a create or update names it. */
export interface SubscriptionItemParams {
  /** Update only: the `si_…` to change or remove. */
  id?: string;
  price?: string;
  quantity?: number;
  /** Update only: remove this item. */
  deleted?: boolean;
  metadata?: Record<string, string>;
}

/** One entry of `discounts[]`. Exactly one of the two. */
export interface DiscountParams {
  coupon?: string;
  promotion_code?: string;
}

export interface CreateSubscriptionParams {
  customer: string;
  items: SubscriptionItemParams[];
  default_payment_method?: string;
  collection_method?: CollectionMethod;
  days_until_due?: number;
  description?: string;
  trial_period_days?: number;
  /** Unix seconds, or `'now'` to end it at once. */
  trial_end?: number | 'now';
  trial_settings?: { end_behavior: { missing_payment_method: TrialEndBehavior } };
  billing_cycle_anchor?: number;
  proration_behavior?: Exclude<ProrationBehavior, 'always_invoice'>;
  cancel_at_period_end?: boolean;
  cancel_at?: number;
  coupon?: string;
  promotion_code?: string;
  discounts?: DiscountParams[];
  payment_behavior?: PaymentBehavior;
  automatic_tax?: { enabled: boolean };
  metadata?: Record<string, string>;
}

export interface UpdateSubscriptionParams {
  items?: SubscriptionItemParams[];
  proration_behavior?: ProrationBehavior;
  /** The instant prorations are computed at (Unix seconds); defaults to now. */
  proration_date?: number;
  default_payment_method?: string | '';
  collection_method?: CollectionMethod;
  days_until_due?: number;
  description?: string | '';
  cancel_at_period_end?: boolean;
  cancel_at?: number | '';
  /** `''` resumes collection. */
  pause_collection?: { behavior: PauseCollectionBehavior; resumes_at?: number } | '';
  trial_end?: number | 'now';
  coupon?: string | '';
  promotion_code?: string;
  discounts?: DiscountParams[] | '';
  payment_behavior?: PaymentBehavior;
  automatic_tax?: { enabled: boolean };
  metadata?: Record<string, string>;
}

/** `DELETE /v1/subscriptions/:id`: cancel now. */
export interface CancelSubscriptionParams {
  /** Bill pending items and prorations now, in a final invoice. */
  invoice_now?: boolean;
  /** Credit the unused time of the current period. */
  prorate?: boolean;
  cancellation_details?: { comment?: string };
}

/** `POST /v1/subscriptions/:id/resume` — a `paused` subscription. */
export interface ResumeSubscriptionParams {
  /** `now` (default) starts a new period at once; `unchanged` keeps the anchor. */
  billing_cycle_anchor?: 'now' | 'unchanged';
  proration_behavior?: ProrationBehavior;
}

export interface SubscriptionListParams extends ListParams {
  customer?: string;
  price?: string;
  /** A status, `all` (including canceled), or `ended` (canceled and incomplete_expired). */
  status?: SubscriptionStatus | 'all' | 'ended';
  test_clock?: string;
  current_period_end?: number | RangeQuery;
}

export interface CreateSubscriptionItemParams {
  subscription: string;
  price: string;
  quantity?: number;
  proration_behavior?: ProrationBehavior;
  proration_date?: number;
  metadata?: Record<string, string>;
}

export interface UpdateSubscriptionItemParams {
  price?: string;
  quantity?: number;
  proration_behavior?: ProrationBehavior;
  proration_date?: number;
  metadata?: Record<string, string>;
}

export interface DeleteSubscriptionItemParams {
  proration_behavior?: ProrationBehavior;
  proration_date?: number;
}

export interface SubscriptionItemListParams extends ListParams {
  subscription: string;
}
