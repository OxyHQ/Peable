// The platform fee on FairCoin payments made on behalf of a seller (ADR 0012
// §D12, final design).
//
// The buyer pays the FULL price to the SELLER with a normal `faircoin:` request
// — any wallet, one address, no custody. The platform's fee is the SELLER's
// cost: Peable records it as a receivable the seller owes the platform when the
// payment settles, and the seller settles it by paying an application-fee
// invoice — again a normal `faircoin:` payment, to an address derived from the
// PLATFORM's own fee key. Nobody but the receiver ever holds the coins.
import type { NetworkType } from './network';

/**
 * One immutable line of a seller's fee ledger with a platform.
 *
 * - `accrued`  — a fee became owed when a payment carrying `applicationFee` settled.
 * - `reversed` — the platform waived (part of) one accrued fee, explicitly.
 * - `payment`  — the seller paid fees on-chain to a fee invoice's address.
 *
 * The ledger is append-only: a mistake is corrected by a new line, never by
 * changing an old one. The seller's balance is accrued − reversed − paid; a
 * negative balance is credit that pays the next fees.
 */
export type ApplicationFeeKind = 'accrued' | 'reversed' | 'payment';

export interface ApplicationFee {
  /** `fee_…` */
  id: string;
  object: 'application_fee';
  kind: ApplicationFeeKind;
  /** The seller (`ca_…`) who owes it. */
  connectedAccountId: string;
  network: NetworkType;
  /** Always positive, in base units; `kind` says which way it moves the balance. */
  amount: string;
  /** The payment it came from (`accrued`) or applies to (`reversed`). */
  paymentIntentId: string | null;
  /** The accrued fee a reversal waives. */
  reversesFeeId: string | null;
  /** The invoice a `payment` was made to, and the transaction that paid it. */
  invoiceId: string | null;
  txid: string | null;
  createdAt: string;
}

/**
 * Where a seller stands on fees with this platform.
 *
 * `due_soon` — fees will be past due within the warning window: the seller has
 * been told. `past_due` — fees older than the platform's grace period are
 * unpaid: the seller's FairCoin rail is `restricted` and new payments on their
 * behalf are refused (`account_past_due`) until they pay. It clears by itself
 * the moment a confirmed payment covers the overdue fees.
 */
export type ApplicationFeeStanding = 'current' | 'due_soon' | 'past_due';

export interface ApplicationFeeBalance {
  /** Accrued − reversed − paid, base units. Negative is credit. */
  outstanding: string;
  /** The part of `outstanding` older than the grace period. */
  pastDue: string;
  standing: ApplicationFeeStanding;
  /** Since when the current standing has held; `null` while `current`. */
  standingSince: string | null;
  /** The platform's grace period, in days, from accrual to past due. */
  graceDays: number;
}

export type ApplicationFeeInvoiceStatus = 'open' | 'paid';

/**
 * A request for the seller to pay their outstanding fees — a normal FairCoin
 * payment request with its OWN address on the platform's fee key, so a payment
 * to it is matched to this invoice exactly.
 *
 * Paying less leaves it `open` with `amountReceived` showing what arrived; the
 * seller pays the rest to the same address. Paying more marks it `paid` and the
 * excess is credit on the seller's balance. Credited only once the transaction
 * has the platform's required confirmations.
 */
export interface ApplicationFeeInvoice {
  /** `fin_…` */
  id: string;
  object: 'application_fee_invoice';
  connectedAccountId: string;
  network: NetworkType;
  /** What was owed when the invoice was made, base units. */
  amount: string;
  /** Confirmed FairCoin received at `address` so far. */
  amountReceived: string;
  /** Where to pay — on the PLATFORM's fee key. */
  address: string;
  /** `faircoin:<address>?amount=<FAIR>` for what is still due — scan with any wallet. */
  paymentUri: string;
  status: ApplicationFeeInvoiceStatus;
  paidAt: string | null;
  createdAt: string;
}

/** Bounded so a mis-typed setting cannot make fees never due, or due at once. */
export const APPLICATION_FEE_GRACE_DAYS_MIN = 1;
export const APPLICATION_FEE_GRACE_DAYS_MAX = 365;
export const APPLICATION_FEE_GRACE_DAYS_DEFAULT = 30;
/** How long before past due a seller is warned (`due_soon`). */
export const APPLICATION_FEE_WARNING_DAYS = 7;
