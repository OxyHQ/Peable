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
  /** The PUBLIC `pi_…` id, which is what every other contract here calls `id`. */
  paymentIntentId: string;
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
   * When the network stops accepting evidence, ISO-8601.
   *
   * `null` once the dispute is closed — there is no deadline for a decision
   * already made, and a closed dispute still showing one would put a response
   * in front of a merchant that can no longer be given.
   */
  evidenceDueAt: string | null;
  createdAt: string;
  updatedAt: string;
}
