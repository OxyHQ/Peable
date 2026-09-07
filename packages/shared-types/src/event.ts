// Webhook event envelope — Stripe-parity dotted event types with the resource
// object nested under `data.object`, delivered HMAC-signed by the dispatcher.
import type { Dispute } from './dispute';
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
   * and may end there. That is also how Stripe models it: a charge is
   * `disputed`, a PaymentIntent has no such status.
   *
   * These two carry a {@link Dispute} as their `data.object`, NOT the payment
   * intent — see {@link WebhookEventPayload}. The `paymentIntentId` on it is
   * how a consumer gets back to the payment.
   *
   * Additive to a published contract: an existing consumer that switches on
   * this union keeps compiling and simply never matches them.
   */
  | 'payment_intent.disputed'
  | 'payment_intent.dispute_closed';

/**
 * Which resource each event type carries under `data.object`.
 *
 * TOTAL over `WebhookEventType`, so a new event type cannot be added without
 * saying what it delivers. That matters more here than anywhere else in this
 * contract: `data.object` is the whole payload, and an event type added with
 * the default would silently ship a PaymentIntent to a consumer expecting
 * something else — which typechecks on both sides and fails only in production.
 */
export interface WebhookEventPayload {
  'payment_intent.confirming': PaymentIntent;
  'payment_intent.settled': PaymentIntent;
  'payment_intent.failed': PaymentIntent;
  'payment_intent.rejected': PaymentIntent;
  'payment_intent.expired': PaymentIntent;
  'payment_intent.refunded': PaymentIntent;
  'payment_intent.partially_refunded': PaymentIntent;
  'payment_intent.disputed': Dispute;
  'payment_intent.dispute_closed': Dispute;
}

/**
 * One delivered event.
 *
 * A DISCRIMINATED union over every event type, so `data.object` is narrowed by
 * a switch on `type` with no cast:
 *
 * ```ts
 * if (event.type === 'payment_intent.disputed') {
 *   event.data.object.evidenceDueAt; // Dispute, not PaymentIntent
 * }
 * ```
 *
 * That correlation is the whole point of building it this way rather than as
 * `{ type: WebhookEventType; data: { object: PaymentIntent | Dispute } }`,
 * which typechecks identically at the boundary and then lets a consumer read a
 * `Dispute`'s fields off a settlement.
 *
 * The parameter narrows to a subset of event types — `WebhookEvent<'payment_intent.disputed'>`
 * is the dispute event alone. It takes an event TYPE and not a payload type,
 * because the payload is derivable from the event and the reverse is not: two
 * event types share `Dispute`.
 */
export type WebhookEvent<K extends WebhookEventType = WebhookEventType> = {
  [T in K]: {
    id: string;
    object: 'event';
    type: T;
    created: string;
    data: { object: WebhookEventPayload[T] };
  };
}[K];
