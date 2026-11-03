// Subscriptions (`sub_…`) and their items (`si_…`) — Orbit's native billing
// engine (ADR 0018). The wire types are the contract's (`@peable.to/contracts`
// `subscriptionSchema`), re-exported here as types; the closed value sets come
// from the zod-free `@peable.to/contracts/vocabulary`.
import type { SubscriptionStatus } from '@peable.to/contracts/vocabulary';

export {
  COLLECTION_METHODS,
  type CollectionMethod,
  PAUSE_COLLECTION_BEHAVIORS,
  PAYMENT_BEHAVIORS,
  type PauseCollectionBehavior,
  type PaymentBehavior,
  PRORATION_BEHAVIORS,
  type ProrationBehavior,
  SUBSCRIPTION_CANCELLATION_REASONS,
  SUBSCRIPTION_STATUSES,
  type SubscriptionCancellationReason,
  type SubscriptionStatus,
  TRIAL_END_BEHAVIORS,
  type TrialEndBehavior,
} from '@peable.to/contracts/vocabulary';

export type {
  CancelSubscriptionParams,
  CreateSubscriptionItemParams,
  CreateSubscriptionParams,
  DeletedSubscriptionItem,
  DeleteSubscriptionItemParams,
  Discount,
  DiscountParams,
  ResumeSubscriptionParams,
  Subscription,
  SubscriptionItem,
  SubscriptionItemListParams,
  SubscriptionItemParams,
  SubscriptionListParams,
  UpdateSubscriptionItemParams,
  UpdateSubscriptionParams,
} from '@peable.to/contracts';

/**
 * The statuses that grant access — what active entitlements are computed from
 * (ADR 0018 §6).
 */
export const SUBSCRIPTION_ENTITLED_STATUSES = [
  'trialing',
  'active',
  'past_due',
] as const satisfies readonly SubscriptionStatus[];
