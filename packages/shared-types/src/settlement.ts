// The settlement contract — connected accounts, transfers and their reversals.
//
// ## Why these are published now
//
// They were declared inside the backend, with a comment saying they stayed
// there "for as long as they are unstable. Publishing a shape is a promise, and
// the settling half of this contract has not yet been exercised end to end."
// The caution was right and it had a cost that grew: Mercaria's adapter
// declared its OWN partial interfaces for the same responses, so the two
// descriptions of one wire format lived in different repositories with nothing
// comparing them. A field renamed here is a runtime failure there, discovered
// by a settlement that does not happen.
//
// One published shape is the smaller risk. A promise that is written down can
// be versioned; two private copies of it cannot even be checked.
//
// ## The provider's own ids are not here, and that is the contract
//
// ADR 0001 D3: a merchant integrates against Peable and never learns which
// acquirer sat behind their seller, because the day that changes should be a
// Peable deploy and not a merchant migration. No `acct_…`, no `tr_…` of
// theirs, no provider name. A reviewer should be able to check that by what is
// absent from these interfaces.
import type { CurrencyCode } from './money';
import type { PaymentIntent } from './paymentIntent';

// Connected accounts, transfers and their reversals: the contract's
// (`@peable.to/contracts`), re-exported here as types.
export type {
  ConnectedAccount,
  ConnectedAccountFaircoin,
  Transfer,
  TransferReversal,
  TransferWithReversal,
} from '@peable.to/contracts';
export type {
  AccountCapabilityStatus as CapabilityStatus,
  ConnectedAccountFaircoinStatus,
  ConnectedAccountRail,
  TransferReversalStatus,
  TransferStatus,
} from '@peable.to/contracts/vocabulary';

/**
 * What a payment actually came to, as the PROVIDER reports it.
 *
 * ## Every figure is nullable, and that is the contract
 *
 * The difference between "the fee was zero" and "the fee is not known yet" is
 * the whole reason this shape exists. A report that renders an unknown as `0`
 * is one a merchant reconciles against and cannot explain — and zero is a
 * number somebody will subtract. `status` says which of the three situations
 * produced the nulls.
 *
 * ## What it does NOT say
 *
 * It reports what the provider took. It does **not** attribute that cost to an
 * entity: a fee paid by the operator of a Peable deployment is not
 * automatically an expense of the marketplace running on it, and that is a
 * commercial decision no contract can make. Nothing here implies one.
 *
 * `gross` is not the payment's `amount`: a partial capture, a refund or a
 * currency conversion all make them differ, which is why it is reported rather
 * than assumed.
 */
export interface Settlement {
  object: 'settlement';
  /**
   * Which of the provider's two worlds this object belongs to (ADR 0017):
   * `true` for a `production` merchant, `false` for every other environment.
   */
  livemode: boolean;
  /** The `pi_…` this describes, or the {@link PaymentIntent} with `expand[]=payment_intent`. */
  payment_intent: string | PaymentIntent;
  /**
   *  - `available` — settled; these figures are final.
   *  - `pending`   — a settlement record exists and is not final yet.
   *  - `unknown`   — there is none to read. **Not zero.**
   */
  status: 'available' | 'pending' | 'unknown';
  /** Minor units, as canonical integer strings, in `currency`. */
  gross: string | null;
  fee: string | null;
  net: string | null;
  /** The SETTLEMENT currency, which may differ from the payment's. */
  currency: string | null;
  /** When the funds become available, Unix seconds. */
  available_on: number | null;
  /** Present only when a conversion happened. `null` is not a rate of 1. */
  exchange_rate: number | null;
}

/**
 * Where one refund stands — the MONEY's own lifecycle, not the payment's.
 * `canceled` only through `POST /v1/refunds/:id/cancel`, where the provider
 * still allows it.
 */
export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

/** Stripe's refund reasons. */
export const REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/**
 * Who created a refund.
 *
 * `provider` means it appeared at the acquirer — a dashboard refund, or the
 * network resolving a dispute — and was imported. Such a refund carries no
 * `externalRef`, because the merchant did not make it and has no id for it.
 */
export type RefundOrigin = 'merchant' | 'provider';

export interface Refund {
  id: string;
  object: 'refund';
  /**
   * Which of the provider's two worlds this object belongs to (ADR 0017):
   * `true` for a `production` merchant, `false` for every other environment.
   */
  livemode: boolean;
  /** `null` on an IMPORTED refund; see {@link RefundOrigin}. */
  external_ref: string | null;
  origin: RefundOrigin;
  /** The refunded payment's `pi_…`, or the {@link PaymentIntent} with `expand[]=payment_intent`. */
  payment_intent: string | PaymentIntent;
  amount: string;
  currency: CurrencyCode | string;
  status: RefundStatus;
  reason: RefundReason | null;
  failure_code: string | null;
  metadata: Record<string, string>;
  created: number;
  updated_at: number;
}

/** `POST /v1/refunds`. */
export interface CreateRefundParams {
  /** The `pi_…` being refunded. */
  payment_intent: string;
  /** YOUR id for this refund. The idempotency. */
  external_ref: string;
  /** Minor units, as a canonical integer string. Zero is refused. */
  amount: string;
  reason?: RefundReason;
  metadata?: Record<string, string>;
  /**
   * Also refund Orbit's application fee, in proportion to the amount refunded
   * (a payment that carried one: a destination charge, ADR 0015 §2).
   */
  refund_application_fee?: boolean;
  /** Also reverse the transfer to the destination account, in proportion. */
  reverse_transfer?: boolean;
}

/** `POST /v1/refunds/:id` — the merchant's own bookkeeping; `metadata` is a patch. */
export interface UpdateRefundParams {
  metadata?: Record<string, string>;
}
