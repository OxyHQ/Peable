import type { PaymentIntent } from './paymentIntent';

/**
 * A dispute — the card network holding a settled payment's money while a
 * cardholder contests it.
 *
 * Published because `payment_intent.disputed` and `payment_intent.dispute_closed`
 * carry it as their `data.object`. It was route-local at first, with the webhook
 * carrying the PaymentIntent and the detail reachable only through
 * `GET /v1/payment_intents/:id/disputes`. That was inconsistent with the reason
 * those two events exist: `disputed` is a DEADLINE, and a merchant who has to
 * make a second call to learn when evidence is due is a merchant who can miss it
 * while their integration is working exactly as documented.
 *
 * It is also what the provider does. Stripe's `charge.dispute.created` carries
 * the dispute, not the charge — the parity was half-applied.
 */

/**
 * Where the dispute stands.
 *
 * `needs_response` and `under_review` are open; `won` and `lost` are terminal
 * and are the only two that say where the money ended up. There is deliberately
 * no `closed`: a merchant who is told a dispute "closed" without being told
 * which way has been given a notification and no information.
 */
export type DisputeStatus = 'needs_response' | 'under_review' | 'won' | 'lost';

export interface Dispute {
  id: string;
  object: 'dispute';
  /**
   * Which of the provider's two worlds this object belongs to (ADR 0017):
   * `true` for a `production` merchant, `false` for every other environment.
   */
  livemode: boolean;
  /** The disputed payment's `pi_…`, or the {@link PaymentIntent} with `expand[]=payment_intent`. */
  payment_intent: string | PaymentIntent;
  /**
   * Amount in the currency's smallest unit as a canonical integer string —
   * the same encoding every other money field on these contracts uses.
   *
   * It is the DISPUTED amount, which may be less than the payment's: a
   * cardholder can contest part of a charge.
   */
  amount: string;
  currency: string;
  status: DisputeStatus;
  /**
   * The network's reason, verbatim and unmapped.
   *
   * Deliberately an open string rather than a closed set. It is the one field a
   * merchant argues against, and a gateway paraphrase would be the words they
   * quote while the acquirer holds different ones. `null` when the network sent
   * none.
   */
  reason: string | null;
  /**
   * When the network stops accepting evidence, Unix seconds.
   *
   * `null` once the dispute is closed — there is no deadline for a decision
   * already made, and a closed dispute still showing one would put a response
   * in front of a merchant that can no longer be given.
   */
  evidence_due_at: number | null;
  /**
   * When the merchant's response reached the network, Unix seconds. `null` while
   * none has been submitted.
   *
   * The timestamp and nothing else: the evidence itself is forwarded to the
   * acquirer and never stored here. What it SAID is readable there, by someone
   * with their own authorization — this gateway does not keep a copy of a
   * customer's name, address and correspondence.
   *
   * Together with `evidenceDueAt` it answers the only two questions a merchant
   * has about a live dispute: whether they still owe a response, and by when.
   */
  evidence_submitted_at: number | null;
  created: number;
  updated_at: number;
}

/**
 * A merchant's response to a dispute — the whole field set, declared once.
 *
 * ## Why this is the wire contract and not four private copies
 *
 * It was four: the backend's provider port, the route's zod schema, the Stripe
 * adapter's name map, and the SDK's params type. Every one of them is the SAME
 * list, and the cost of them drifting is specific and silent — a field added to
 * three of the four is one a merchant sends, the gateway accepts, and the
 * network never sees. They find out when the dispute is decided against them.
 *
 * So the set lives here, with the wire contracts, and the other three are
 * pinned to it: `provider.ts` aliases it, `routes/disputes.ts` declares its
 * schema `satisfies Record<keyof DisputeEvidence, …>`, and the Stripe adapter's
 * map is a total `Record<keyof DisputeEvidence, …>`. Adding a field here makes
 * all three fail to compile until they carry it.
 *
 * ## What is not here
 *
 * The field NAMES are the network's, spelled the way the rest of these
 * contracts spell things. They are not a Peable vocabulary and are not mapped
 * to one: a merchant assembling a defence is reading their acquirer's guidance,
 * and a gateway that renamed the fields would make that guidance not apply.
 *
 * FILE attachments are deliberately absent. They need the provider's upload
 * API, a size and type policy, and somewhere for the bytes to live on the way
 * through — and offering half of that would let a merchant submit a defence
 * missing the receipt it rests on.
 *
 * None of it is ever stored. It carries a customer's name, their email, a
 * billing address and correspondence; it is forwarded to the acquirer and
 * forgotten. What is recorded is `evidenceSubmittedAt` and nothing more.
 */
export interface DisputeEvidence {
  product_description?: string;
  customer_name?: string;
  customer_email_address?: string;
  customer_purchase_ip?: string;
  billing_address?: string;
  shipping_address?: string;
  shipping_carrier?: string;
  shipping_date?: string;
  shipping_tracking_number?: string;
  service_date?: string;
  access_activity_log?: string;
  cancellation_policy_disclosure?: string;
  cancellation_rebuttal?: string;
  duplicate_charge_explanation?: string;
  refund_policy_disclosure?: string;
  refund_refusal_explanation?: string;
  uncategorized_text?: string;
}
