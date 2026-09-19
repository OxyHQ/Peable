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

/** How a provider reports one capability on a seller's account. */
export type CapabilityStatus = 'active' | 'pending' | 'inactive';

/** Where one settlement stands. */
export type TransferStatus =
  | 'pending'
  | 'paid'
  | 'partially_reversed'
  | 'reversed'
  | 'failed';

/** Where one reversal of a settlement stands. */
export type TransferReversalStatus = 'pending' | 'succeeded' | 'failed';

export interface ConnectedAccount {
  id: string;
  object: 'connected_account';
  /** The merchant's OWN id for this seller — how they address it. */
  externalRef: string;
  /** ISO 3166-1 alpha-2, upper-case. */
  country: string;
  defaultCurrency: string | null;
  /**
   * Whether this seller can receive a settlement right now.
   *
   * A CONVENIENCE, not the authority: every field it is derived from is here
   * too, and a marketplace with its own readiness policy reads those instead.
   * Offering only this boolean would make the gateway the authority on a
   * question that belongs to the merchant.
   */
  payable: boolean;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  /**
   * `null` means the capability was never REQUESTED, which is a different fact
   * from the provider declining it (`inactive`). Collapsing the two makes "why
   * is this seller stuck" unanswerable.
   */
  transfersCapability: CapabilityStatus | null;
  cardPaymentsCapability: CapabilityStatus | null;
  /**
   * COUNTS of outstanding requirements, never the requirements themselves and
   * never their values. The gateway records that a seller owes a document; it
   * does not learn what the document says.
   */
  requirements: {
    currentlyDue: number;
    eventuallyDue: number;
    pastDue: number;
    pendingVerification: number;
  };
  disabledReasonCodes: readonly string[];
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Transfer {
  id: string;
  object: 'transfer';
  /** The merchant's OWN id for what this settles. Their idempotency. */
  externalRef: string;
  /** The `ca_…` of the seller — never their account id at the provider. */
  connectedAccountId: string;
  /** The `pi_…` this settlement was funded by — never an internal primary key. */
  paymentIntentId: string;
  amount: string;
  currency: string;
  /**
   * CUMULATIVE, in the same units as `amount` — never one reversal's figure.
   *
   * A caller deciding whether a settlement is fully reversed must not have to
   * add up reversals it may not have all seen, which is why this is the
   * provider's own total rather than a sum of the reversals below.
   */
  amountReversed: string;
  status: TransferStatus;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One reversal operation, returned beside the settlement it acted on.
 *
 * It exists as an object because an AMOUNT IS NOT AN IDENTITY: two reversals of
 * one settlement for the same amount are two operations, and a caller needs to
 * be able to tell which one a response is about.
 */
export interface TransferReversal {
  id: string;
  object: 'transfer_reversal';
  /** The merchant's own id for this reversal — their `Idempotency-Key`. */
  externalRef: string;
  amount: string;
  currency: string;
  status: TransferReversalStatus;
  failureMessage: string | null;
  createdAt: string;
}

/** What `POST /v1/transfers/:id/reversals` answers: the transfer, and the leg. */
export interface TransferWithReversal extends Transfer {
  reversal: TransferReversal;
}

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
  /** The `pi_…` this describes. */
  paymentIntentId: string;
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
  /** When the funds become available, ISO-8601. */
  availableOn: string | null;
  /** Present only when a conversion happened. `null` is not a rate of 1. */
  exchangeRate: number | null;
}

/** Where one refund stands — the MONEY's own lifecycle, not the payment's. */
export type RefundStatus = 'pending' | 'succeeded' | 'failed';

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
  /** `null` on an IMPORTED refund; see {@link RefundOrigin}. */
  externalRef: string | null;
  origin: RefundOrigin;
  paymentIntentId: string;
  amount: string;
  currency: CurrencyCode | string;
  status: RefundStatus;
  /**
   * Where the PAYMENT stands after this refund.
   *
   * On the refund deliberately: a caller that has just refunded needs to know
   * whether the payment is now `partially_refunded` or `refunded`, and making
   * them re-read the intent is a round trip whose answer can move on before it
   * arrives.
   */
  paymentStatus: string;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}
