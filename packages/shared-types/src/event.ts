// Webhook event envelope — Stripe-parity dotted event types with the resource
// object nested under `data.object`, delivered HMAC-signed by the dispatcher.
import type { PaymentIntent } from './paymentIntent';

export type WebhookEventType =
  | 'payment_intent.confirming'
  | 'payment_intent.settled'
  | 'payment_intent.failed'
  | 'payment_intent.rejected'
  | 'payment_intent.expired'
  /**
   * Money went back to the payer.
   *
   * Both of these exist for the refund a merchant did NOT initiate — one made
   * from the provider's own dashboard, or a dispute the network resolved
   * against the merchant. A merchant who only ever learned about their own
   * refunds would reconcile to a balance that disagrees with the provider's,
   * with nothing to explain the difference.
   *
   * Additive to a published contract: an existing consumer that switches on
   * this union keeps compiling and simply never matches them.
   */
  | 'payment_intent.refunded'
  | 'payment_intent.partially_refunded'
  /**
   * The network is holding this payment's money while a cardholder contests it.
   *
   * Two events and not one because the two moments demand different things of a
   * merchant. `disputed` is a DEADLINE — evidence is due, and a merchant who
   * learns about it late has already lost. `dispute_closed` carries the outcome,
   * which is when the money is finally theirs or finally gone.
   *
   * Neither is a payment-intent STATUS. A dispute is the network's process, not
   * a stage of the payment's lifecycle — the payment stayed `settled` throughout
   * and may end there. The detail lives in the dispute rows
   * (`GET /v1/payment_intents/:id/disputes`), which is also how Stripe models
   * it: a charge is `disputed`, a PaymentIntent has no such status.
   *
   * Additive to a published contract: an existing consumer that switches on
   * this union keeps compiling and simply never matches them.
   */
  | 'payment_intent.disputed'
  | 'payment_intent.dispute_closed';

export interface WebhookEvent<T = PaymentIntent> {
  id: string;
  object: 'event';
  type: WebhookEventType;
  created: string;
  data: { object: T };
}
