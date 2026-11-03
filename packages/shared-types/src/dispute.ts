import type { Charge } from './charge';
import type { CurrencyCode } from './money';
import type { PaymentIntent } from './paymentIntent';

/**
 * A dispute — the card network holding a payment's money while a cardholder
 * contests it. Stripe's Dispute object (`dp_…`), Orbit's row.
 *
 * `charge.dispute.created|updated|closed|funds_withdrawn|funds_reinstated`
 * carry it as `data.object`. A dispute is a DEADLINE: `created` carries
 * `evidence_details.due_by`, so a merchant never needs a second call to learn
 * when their response is due.
 */

/**
 * Where the dispute stands.
 *
 * `needs_response` and `under_review` are open; `won` and `lost` are terminal
 * and are the only two that say where the money ended up. The provider's
 * `warning_*` inquiry states collapse onto the state they warn about. There is
 * deliberately no `closed`: a merchant told a dispute "closed" without being
 * told which way has been given a notification and no information.
 */
export type DisputeStatus = 'needs_response' | 'under_review' | 'won' | 'lost';

/**
 * Why the cardholder disputed — Stripe's enum. A network reason code the
 * provider does not map to one of these reads `general`; the row keeps the
 * provider's own word, so nothing is lost by the normalisation.
 */
export const DISPUTE_REASONS = [
  'bank_cannot_process',
  'check_returned',
  'credit_not_processed',
  'customer_initiated',
  'debit_not_authorized',
  'duplicate',
  'fraudulent',
  'general',
  'incorrect_account_details',
  'insufficient_funds',
  'noncompliant',
  'product_not_received',
  'product_unacceptable',
  'subscription_canceled',
  'unrecognized',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

/** Map any provider reason onto {@link DisputeReason}: unknown or absent is `general`. */
export function normalizeDisputeReason(reason: string | null | undefined): DisputeReason {
  return (DISPUTE_REASONS as readonly string[]).includes(reason ?? '')
    ? (reason as DisputeReason)
    : 'general';
}

/**
 * The TEXT evidence fields — the network's names, spelled the way the rest of
 * these contracts spell things, never a Peable paraphrase: a merchant assembling
 * a defence is reading their acquirer's guidance, and renamed fields would make
 * that guidance not apply.
 *
 * Declared ONCE. The route's schema is `satisfies Record<DisputeTextEvidenceField, …>`
 * and the Stripe adapter's name map is a total `Record`, so a field added here
 * does not compile until both carry it — the drift that would let a merchant
 * send a field the network never sees.
 */
export const DISPUTE_TEXT_EVIDENCE_FIELDS = [
  'access_activity_log',
  'billing_address',
  'cancellation_policy_disclosure',
  'cancellation_rebuttal',
  'customer_email_address',
  'customer_name',
  'customer_purchase_ip',
  'duplicate_charge_explanation',
  'product_description',
  'refund_policy_disclosure',
  'refund_refusal_explanation',
  'service_date',
  'shipping_address',
  'shipping_carrier',
  'shipping_date',
  'shipping_tracking_number',
  'uncategorized_text',
] as const;
export type DisputeTextEvidenceField = (typeof DISPUTE_TEXT_EVIDENCE_FIELDS)[number];

/**
 * The FILE evidence fields. Each names a `file_…` of purpose `dispute_evidence`
 * uploaded by the same merchant; its bytes go to the provider when the response
 * is submitted, and only then.
 */
export const DISPUTE_FILE_EVIDENCE_FIELDS = [
  'cancellation_policy',
  'customer_communication',
  'customer_signature',
  'duplicate_charge_documentation',
  'receipt',
  'refund_policy',
  'service_documentation',
  'shipping_documentation',
  'uncategorized_file',
] as const;
export type DisputeFileEvidenceField = (typeof DISPUTE_FILE_EVIDENCE_FIELDS)[number];

export type DisputeEvidenceField = DisputeTextEvidenceField | DisputeFileEvidenceField;

/**
 * A merchant's evidence as the dispute holds it: every field, `null` when unset.
 *
 * Present ONLY on a live read — `GET /v1/disputes/:id` and the answers of
 * `POST /v1/disputes/:id` and `…/close`. The text half is read from the
 * provider, which is where a draft lives (Peable never stores it); the file half
 * is the `file_…` ids the merchant attached. Lists and event payloads never
 * carry it: an event is stored, and evidence carries a customer's name, email,
 * address and correspondence.
 */
export type DisputeEvidence = Record<DisputeEvidenceField, string | null>;

/**
 * `evidence` on `POST /v1/disputes/:id`: any subset of the fields. A text field
 * is the merchant's words; a file field is a `file_…`. An empty string UNSETS
 * the field, as on Stripe.
 */
export type DisputeEvidenceParams = Partial<Record<DisputeEvidenceField, string>>;

/** The response's bookkeeping — Stripe's `evidence_details`, plus when it was submitted. */
export interface DisputeEvidenceDetails {
  /**
   * When the network stops accepting evidence, Unix seconds. `null` once the
   * dispute is closed — there is no deadline for a decision already made.
   */
  due_by: number | null;
  /** Whether any evidence has been staged or submitted. */
  has_evidence: boolean;
  /** Whether the deadline passed without a submission. */
  past_due: boolean;
  /** `0` or `1`: a response is one-shot at the network. */
  submission_count: number;
  /** When the response reached the network, Unix seconds; `null` while it has not. */
  submitted_at: number | null;
}

export interface Dispute {
  id: string;
  object: 'dispute';
  /**
   * Which of the provider's two worlds this object belongs to (ADR 0017):
   * `true` for a `production` merchant, `false` for every other environment.
   */
  livemode: boolean;
  /**
   * The DISPUTED amount in the currency's smallest unit, as a canonical integer
   * string. It may be less than the payment's: a cardholder can contest part of
   * a charge.
   */
  amount: string;
  currency: CurrencyCode;
  /** `ch_…`, or the {@link Charge} with `expand[]=charge`. */
  charge: string | Charge | null;
  /** The disputed payment's `pi_…`, or the {@link PaymentIntent} with `expand[]=payment_intent`. */
  payment_intent: string | PaymentIntent;
  status: DisputeStatus;
  reason: DisputeReason;
  /**
   * Whether the disputed payment can still be refunded. Once it has been in
   * full, no further funds are withdrawn because of this dispute.
   */
  is_charge_refundable: boolean;
  evidence_details: DisputeEvidenceDetails;
  /** Live reads only — see {@link DisputeEvidence}. */
  evidence?: DisputeEvidence;
  metadata: Record<string, string>;
  created: number;
  updated_at: number;
}

/**
 * `POST /v1/disputes/:id`.
 *
 * `submit: false` (the default) STAGES the evidence: text goes to the provider
 * as a draft, files are attached by id. `submit: true` uploads the attached
 * files to the provider and submits everything — ONCE; a second submission is
 * refused, because the network takes one response.
 */
export interface UpdateDisputeParams {
  evidence?: DisputeEvidenceParams;
  /** A PATCH (`""` unsets a key). */
  metadata?: Record<string, string>;
  submit?: boolean;
}

/** `GET /v1/disputes`. */
export interface ListDisputesParams {
  payment_intent?: string;
  charge?: string;
}
