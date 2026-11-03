// The PaymentIntent contract — the single source of truth shared by the Peable
// Gateway backend, SDK, and frontend. Stripe's PaymentIntent, at the root
// (ADR 0019): one status vocabulary over two rails — the non-custodial FairCoin
// lifecycle, and a fiat card payment served by a provider behind the gateway
// (ADR 0001).
import type { Charge } from './charge';
import type { Customer } from './customer';
import type { CurrencyCode } from './money';
import type { NetworkType } from './network';
import type { PaymentMethod } from './paymentMethod';
import type { ConnectedAccount } from './settlement';

/**
 * Which rail moves the money (ADR 0001 D1).
 *
 * On the INTENT, not on the merchant: one merchant takes both, and a merchant's
 * capabilities are a different question from what this particular payment is.
 * The rail decides which of the fields below mean anything.
 */
export type PaymentIntentRail = 'faircoin' | 'card';

/** {@link PaymentIntentRail} as the tuple the database CHECK reads. */
export const PAYMENT_INTENT_RAILS: readonly PaymentIntentRail[] = ['faircoin', 'card'];

/**
 * Stripe's seven statuses, and no others (ADR 0019).
 *
 * The FairCoin rail walks four of them: it is created in `requires_action`
 * (the payer must broadcast a transaction — `next_action.faircoin_payment`),
 * moves to `processing` once a transaction is reported and while it confirms,
 * and ends `succeeded` or `canceled`. A card walks all seven.
 */
export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

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

/** Every `PaymentIntentStatus`, derived from `ALLOWED`'s keys. */
export const PAYMENT_INTENT_STATUSES: readonly PaymentIntentStatus[] = Object.keys(
  ALLOWED,
) as PaymentIntentStatus[];

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

/**
 * Why an intent was cancelled — Stripe's reasons, plus `underpaid`.
 *
 *  - `abandoned` — it expired: the payer never paid (the expiry sweeper).
 *  - `requested_by_customer` / `duplicate` / `fraudulent` — the merchant said so
 *    through `POST /v1/payment_intents/:id/cancel`.
 *  - `underpaid` — FairCoin only: a transaction arrived at the address and paid
 *    less than the amount. Peable never holds those coins, so it cannot ask for
 *    the difference on the same intent; `last_payment_error` says what happened.
 *  - `automatic` — the provider cancelled it on its own.
 *
 * `null` on a cancelled intent whose cause was never recorded (one cancelled
 * without a reason, or migrated from the pre-0019 `rejected`).
 */
export type PaymentIntentCancellationReason =
  | 'abandoned'
  | 'automatic'
  | 'duplicate'
  | 'fraudulent'
  | 'requested_by_customer'
  | 'underpaid';

export const PAYMENT_INTENT_CANCELLATION_REASONS: readonly PaymentIntentCancellationReason[] = [
  'abandoned',
  'automatic',
  'duplicate',
  'fraudulent',
  'requested_by_customer',
  'underpaid',
];

/** The reasons a MERCHANT may give `POST /v1/payment_intents/:id/cancel`. */
export const MERCHANT_CANCELLATION_REASONS = [
  'abandoned',
  'duplicate',
  'fraudulent',
  'requested_by_customer',
] as const satisfies readonly PaymentIntentCancellationReason[];

/** When a card is captured: at confirmation, or by `POST …/capture` (card only). */
export type PaymentIntentCaptureMethod = 'automatic' | 'manual';
export const PAYMENT_INTENT_CAPTURE_METHODS: readonly PaymentIntentCaptureMethod[] = [
  'automatic',
  'manual',
];

/** Card only: keep the payment method on the customer for later (ADR 0016). */
export type PaymentIntentSetupFutureUsage = 'on_session' | 'off_session';
export const PAYMENT_INTENT_SETUP_FUTURE_USAGES: readonly PaymentIntentSetupFutureUsage[] = [
  'on_session',
  'off_session',
];

/** The payment method types a rail accepts. One per rail today. */
export type PaymentMethodType = 'card' | 'faircoin';

/** Why the last attempt failed. Peable's words, never the provider's raw prose. */
export interface PaymentIntentLastPaymentError {
  /** `card_error` for a declined card; `payment_error` for a FairCoin underpayment. */
  type: 'card_error' | 'payment_error' | 'api_error';
  code: string | null;
  decline_code: string | null;
  message: string;
}

/** A postal address — Stripe's shape. */
export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
}

export interface Shipping {
  name: string;
  phone: string | null;
  address: Address;
  carrier: string | null;
  tracking_number: string | null;
}

/** An address as a request carries it: every field optional. */
export interface AddressParams {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
}

/** Shipping as a request carries it: only `name` and `address` are required. */
export interface ShippingParams {
  name: string;
  phone?: string;
  address: AddressParams;
  carrier?: string;
  tracking_number?: string;
}

/**
 * What the payer must do next (`status: 'requires_action'`).
 *
 *  - `faircoin_payment` — send exactly `amount` (base units) to `address` on
 *    `network`; `uri` is the BIP21-style `faircoin:` URI a wallet scans.
 *  - `use_peable_sdk` — a card challenge; `@peable.to/sdk/checkout` fetches the
 *    provider's confirmation credential through `POST …/client_action` and
 *    completes it. The credential is never on the intent itself.
 */
export type PaymentIntentNextAction =
  | {
      type: 'faircoin_payment';
      faircoin_payment: {
        address: string;
        network: NetworkType;
        amount: string;
        currency: 'FAIR';
        uri: string;
      };
    }
  | { type: 'use_peable_sdk' };

/**
 * The chain side of a FairCoin payment. `null` on a card payment.
 *
 * `txid` and `confirmations` describe the transaction the payer reported:
 * `null`/`0` while the intent is `requires_action`, and the watcher's count
 * against `required_confirmations` while it is `processing`.
 */
export interface PaymentIntentFaircoin {
  network: NetworkType;
  /** Watch-only receive address derived per intent from the merchant's (or seller's) xpub. */
  address: string;
  txid: string | null;
  confirmations: number;
  required_confirmations: number;
}

export interface PaymentIntent {
  id: string;
  object: 'payment_intent';
  /**
   * Which of the provider's two worlds this object belongs to (ADR 0017):
   * `true` for a `production` merchant, `false` for every other environment.
   */
  livemode: boolean;
  status: PaymentIntentStatus;
  /** Which rail moves this payment. Decides which fields below are populated. */
  rail: PaymentIntentRail;
  payment_method_types: PaymentMethodType[];
  /**
   * Amount in the currency's SMALLEST unit as a canonical integer string.
   * Never a float, and never interpretable without `currency`: m⊜ (10^-8 FAIR)
   * on the faircoin rail, cents on a fiat one.
   */
  amount: string;
  /** What can still be captured: the authorized amount while `requires_capture`, else `"0"`. */
  amount_capturable: string;
  /** What was received: the captured amount once `succeeded`, else `"0"`. */
  amount_received: string;
  /** The sum of SUCCEEDED refunds on this payment. Refund state lives on the refunds. */
  amount_refunded: string;
  currency: CurrencyCode;
  capture_method: PaymentIntentCaptureMethod;
  setup_future_usage: PaymentIntentSetupFutureUsage | null;
  /** `cus_…`, or the {@link Customer} with `expand[]=customer`. */
  customer: string | Customer | null;
  /** `pm_…`, or the {@link PaymentMethod} with `expand[]=payment_method`. Card only. */
  payment_method: string | PaymentMethod | null;
  /** `ch_…`, or the {@link Charge} with `expand[]=latest_charge`. Card only. */
  latest_charge: string | Charge | null;
  next_action: PaymentIntentNextAction | null;
  last_payment_error: PaymentIntentLastPaymentError | null;
  cancellation_reason: PaymentIntentCancellationReason | null;
  canceled_at: number | null;
  description: string | null;
  receipt_email: string | null;
  /** Card only. */
  statement_descriptor_suffix: string | null;
  shipping: Shipping | null;
  /** The chain side. FairCoin rail only; `null` on a card payment. */
  faircoin: PaymentIntentFaircoin | null;
  /** The merchant's PUBLIC `merch_…`. */
  merchant_id: string;
  /**
   * The seller this payment is made ON BEHALF OF (`ca_…`), or `null` for a
   * payment to the merchant itself (ADR 0012 D5). On-behalf payments are
   * FairCoin only, and `faircoin.address` derives from that seller's own key.
   */
  connected_account: string | ConnectedAccount | null;
  client_secret: string;
  metadata: Record<string, string>;
  /** When an UNPAID intent expires. Meaningful only while `can_expire`. */
  expires_at: number;
  /** Whether this intent can still expire (ADR 0012 D9). */
  can_expire: boolean;
  created: number;
  updated_at: number;
}

/** `POST /v1/payment_intents`. */
export interface CreatePaymentIntentParams {
  /** Amount in the currency's smallest unit, as a canonical integer string. */
  amount: string;
  /** Defaults to `'faircoin'`. */
  rail?: PaymentIntentRail;
  /** Required on the faircoin rail; refused on the card rail, which has none. */
  network?: NetworkType;
  /** Defaults to `'FAIR'` on the faircoin rail; required on the card rail. */
  currency?: CurrencyCode;
  /** Must name the rail's own type: `['card']` or `['faircoin']`. */
  payment_method_types?: PaymentMethodType[];
  /** `cus_…`. */
  customer?: string;
  /** `pm_…`, card only. A saved payment method of `customer`. */
  payment_method?: string;
  /** Card only: confirm in the same call (needs `payment_method`). */
  confirm?: boolean;
  /** Card only, with `confirm`: the customer is not present (needs `customer`). */
  off_session?: boolean;
  /** Card only. */
  setup_future_usage?: PaymentIntentSetupFutureUsage;
  /** Card only. Defaults to `'automatic'`. */
  capture_method?: PaymentIntentCaptureMethod;
  receipt_email?: string;
  description?: string;
  /** Card only. */
  statement_descriptor_suffix?: string;
  shipping?: ShippingParams;
  metadata?: Record<string, string>;
  expires_in_seconds?: number;
  /** FairCoin only: pay this seller (`ca_…`, ADR 0012 D5). */
  connected_account?: string;
  /** Card only, with `confirm`: where a redirect-based challenge returns. */
  return_url?: string;
}

/**
 * `POST /v1/payment_intents/:id`. The merchant's own bookkeeping only —
 * the amount, rail and status are the payment and move through their own
 * operations. `metadata` is a PATCH (`""` unsets a key).
 */
export interface UpdatePaymentIntentParams {
  metadata?: Record<string, string>;
  description?: string;
  receipt_email?: string;
  shipping?: ShippingParams;
}

/** `POST /v1/payment_intents/:id/confirm` (card only). */
export interface ConfirmPaymentIntentParams {
  /** `pm_…`; defaults to the intent's own. */
  payment_method?: string;
  off_session?: boolean;
  setup_future_usage?: PaymentIntentSetupFutureUsage;
  return_url?: string;
  receipt_email?: string;
  shipping?: ShippingParams;
}

/** `POST /v1/payment_intents/:id/capture` (card only, `requires_capture`). */
export interface CapturePaymentIntentParams {
  /** Base units, at most the authorized amount; defaults to all of it. */
  amount_to_capture?: string;
}

/** `POST /v1/payment_intents/:id/cancel`. */
export interface CancelPaymentIntentParams {
  cancellation_reason?: (typeof MERCHANT_CANCELLATION_REASONS)[number];
}
