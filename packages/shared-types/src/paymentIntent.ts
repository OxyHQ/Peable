// The PaymentIntent — Stripe's, at the root (ADR 0019): one status vocabulary
// over two rails, the non-custodial FairCoin lifecycle and a fiat card payment
// served by a provider behind the gateway (ADR 0001).
//
// The wire types are the contract's (`@peable.to/contracts`
// `paymentIntentSchema` and its request schemas), re-exported here as types;
// the closed value sets are the contract's zod-free vocabulary. What stays
// here is the lifecycle — the transition table and the predicates over it —
// which is runtime behaviour, not wire shape.
import type { PaymentIntentStatus } from '@peable.to/contracts/vocabulary';

export type {
  Address,
  AddressParams,
  CancelPaymentIntentParams,
  CapturePaymentIntentParams,
  ClientAction,
  ConfirmPaymentIntentParams,
  CreatePaymentIntentParams,
  ListPaymentIntentsParams,
  PaymentIntent,
  PaymentIntentClientAction,
  FaircoinPaymentOutput,
  FaircoinQuote,
  PaymentIntentFaircoin,
  PaymentIntentLastPaymentError,
  PaymentIntentNextAction,
  PaymentIntentTransferData,
  RetrievePaymentIntentParams,
  Shipping,
  ShippingParams,
  SubmitPaymentIntentTxParams,
  UpdatePaymentIntentParams,
} from '@peable.to/contracts';
export {
  MERCHANT_CANCELLATION_REASONS,
  type MerchantCancellationReason,
  PAYMENT_INTENT_CANCELLATION_REASONS,
  PAYMENT_INTENT_CAPTURE_METHODS,
  PAYMENT_INTENT_RAILS,
  PAYMENT_INTENT_SETUP_FUTURE_USAGES,
  PAYMENT_INTENT_STATUSES,
  PAYMENT_METHOD_TYPES,
  type PaymentIntentCancellationReason,
  type PaymentIntentCaptureMethod,
  type PaymentIntentRail,
  type PaymentIntentSetupFutureUsage,
  type PaymentIntentStatus,
  type PaymentMethodType,
} from '@peable.to/contracts/vocabulary';

/**
 * The statuses only a CARD payment can reach (ADR 0019).
 *
 * A FairCoin payment has no payment method to require (the payer's wallet signs
 * on their own device), nothing to confirm server-side, and no authorization
 * to capture — coins either arrive or they do not. `db/schema/payments.ts`
 * renders this set into a CHECK, so the restriction holds against a write that
 * skipped the application.
 */
export const CARD_ONLY_STATUSES: readonly PaymentIntentStatus[] = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_capture',
];

/**
 * Legal transitions of the PaymentIntent lifecycle.
 *
 * ONE table for both rails. It answers "is this a legal lifecycle edge at all";
 * WHICH rail may reach a given status is the separate, structural question
 * {@link CARD_ONLY_STATUSES} answers in the database, and which EVENT may walk
 * an edge is `LEGAL_SOURCES` in the backend's `services/intentState.ts`.
 *
 * Self-transitions are absent because `applyEvent` short-circuits on
 * `current === target` — the idempotent re-poll of the settlement watcher.
 *
 * `succeeded` has no outgoing edge here. Its one exception — a chain reorg
 * dropping a FairCoin payment back below its confirmation threshold,
 * `succeeded → processing` — is modelled by the backend state machine, not this
 * table. Refunds are not statuses: money coming back is `amount_refunded` and
 * the refunds themselves (ADR 0019).
 */
const ALLOWED: Record<PaymentIntentStatus, readonly PaymentIntentStatus[]> = {
  requires_payment_method: [
    'requires_confirmation',
    'requires_action',
    'processing',
    'requires_capture',
    'succeeded',
    'canceled',
  ],
  requires_confirmation: [
    'requires_payment_method',
    'requires_action',
    'processing',
    'requires_capture',
    'succeeded',
    'canceled',
  ],
  // FairCoin: the payer broadcasts (→ processing), or the intent is cancelled
  // or expires (→ canceled). Card: an SCA challenge resolved either way.
  requires_action: [
    'requires_payment_method',
    'processing',
    'requires_capture',
    'succeeded',
    'canceled',
  ],
  // FairCoin: confirmed (→ succeeded) or underpaid (→ canceled). Card: an async
  // method settled, was authorized, or failed back to `requires_payment_method`.
  processing: ['requires_payment_method', 'requires_capture', 'succeeded', 'canceled'],
  requires_capture: ['processing', 'succeeded', 'canceled'],
  succeeded: [],
  canceled: [],
};

export function isValidStatusTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
): boolean {
  return ALLOWED[from].includes(to);
}

/** The statuses that end a payment: nothing leaves them (bar the reorg exception). */
export const TERMINAL_STATUSES: readonly PaymentIntentStatus[] = ['succeeded', 'canceled'];

/**
 * Whether a payer can still complete a payment against an intent in this
 * status — every non-terminal one. Stated, not derived from reachability:
 * `paymentIntent.test.ts` pins it against the table.
 */
export function canStillBePaid(status: PaymentIntentStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

/**
 * The statuses an intent may still EXPIRE from (ADR 0012 D9).
 *
 * The gateway is waiting on a PERSON who has not paid: a FairCoin payer who has
 * not broadcast (`requires_action`), or a card payer who has not completed a
 * payment method or a challenge. Once a FairCoin payer has reported a
 * transaction (`processing`) the intent NEVER expires, whatever `expires_at`
 * says — coins are moving and the settlement watcher owns the row. An
 * authorization held for capture (`requires_capture`) is the merchant's to
 * capture or cancel and does not expire either.
 *
 * Expiry is a cancellation with `cancellation_reason: 'abandoned'`: a platform
 * releases a reservation on `payment_intent.canceled`.
 */
export const EXPIRABLE_STATUSES: readonly PaymentIntentStatus[] = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
];

/** Whether an intent in this status can still expire. See {@link EXPIRABLE_STATUSES}. */
export function canExpire(status: PaymentIntentStatus): boolean {
  return EXPIRABLE_STATUSES.includes(status);
}
