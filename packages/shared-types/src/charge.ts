// A Charge — the read-only record of the money a CARD PaymentIntent moved
// (ADR 0019). Peable's object (`ch_…`) over the provider's charge, which stays
// an internal binding (ADR 0016). A FairCoin payment has no charge: its chain
// side is `PaymentIntent.faircoin`.
import type { CurrencyCode } from './money';
import type { PaymentIntent } from './paymentIntent';

/** Card details safe to show: never the number, never the CVC. */
export interface CardDetails {
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  /** ISO 3166-1 alpha-2 of the issuer. */
  country: string | null;
  /** `credit`, `debit`, `prepaid` or `unknown`. */
  funding: string | null;
}

export interface ChargeOutcome {
  /** `approved_by_network`, `declined_by_network`, `not_sent_to_network`, `reversed_after_approval`. */
  network_status: string | null;
  /** `normal`, `elevated`, `highest`, or `not_assessed`. */
  risk_level: string | null;
  /** `authorized`, `manual_review`, `issuer_declined`, `blocked`, `invalid`. */
  type: string | null;
  /** Peable's own one-line explanation for the merchant — never the provider's prose. */
  seller_message: string | null;
}

export interface Charge {
  id: string;
  object: 'charge';
  livemode: boolean;
  /** `pi_…`, or the {@link PaymentIntent} with `expand[]=payment_intent`. */
  payment_intent: string | PaymentIntent;
  customer: string | null;
  payment_method: string | null;
  amount: string;
  amount_captured: string;
  amount_refunded: string;
  currency: CurrencyCode;
  /** Always `succeeded`: Peable records the authorization that succeeded, not failed attempts. */
  status: 'succeeded';
  paid: boolean;
  captured: boolean;
  /** All of it came back — by refunds, or by releasing an uncaptured authorization. */
  refunded: boolean;
  disputed: boolean;
  outcome: ChargeOutcome | null;
  payment_method_details: { type: 'card'; card: CardDetails } | null;
  /** Peable-hosted receipts land with Phase 3; the provider's own URL never reaches the wire. */
  receipt_url: string | null;
  /**
   * The ledger's `txn_…` for this charge once the provider's balance
   * transaction was ingested (ADR 0015 §4); `null` until then — never a guess.
   */
  balance_transaction: string | null;
  /** Orbit's `fee_…` taken on this charge, once the provider created it. */
  application_fee: string | null;
  /** The fee instructed on the payment (`application_fee_amount`), or `null`. */
  application_fee_amount: string | null;
  description: string | null;
  receipt_email: string | null;
  metadata: Record<string, string>;
  created: number;
}
