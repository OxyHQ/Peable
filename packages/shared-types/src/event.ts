// Event envelope — Stripe's event names (ADR 0019) with the resource object
// nested under `data.object`. Stored once (`/v1/events`, 30 days) and delivered
// HMAC-signed to every matching webhook endpoint (ADR 0014 D4).
import type { Charge } from './charge';
import type { Coupon, Price, Product, PromotionCode } from './catalog';
import type { Customer } from './customer';
import type { Dispute } from './dispute';
import type { PaymentIntent } from './paymentIntent';
import type { PaymentMethod } from './paymentMethod';
import type { ConnectedAccount, Refund } from './settlement';
import type { SetupIntent } from './setupIntent';
import type { WebhookEndpoint } from './webhookEndpoint';

/**
 * The wire date every response names in `Peable-Version`, and the
 * `api_version` an event is stored under (ADR 0014 D2/D4). One constant, so
 * the header and the stored events cannot name two different wires.
 */
export const PEABLE_API_VERSION = '2026-11-03';

/** Wake-up only. Re-read the owner-bound SDK resource; this is never paid or grant authority. */
export interface BillingObservation {
  object: 'billing_observation';
  /** The mode of the billing cohort observed (ADR 0017). */
  livemode: boolean;
  resource_kind: 'subscription' | 'invoice';
  resource_id: string;
  /** Owner-scoped wake-up hint only; re-read the subscription before resolving a payer. */
  subscription_id?: string;
  revision: number;
  observed_at: number;
}

/**
 * Which resource each event type carries under `data.object`.
 *
 * TOTAL over {@link WebhookEventType} (which is derived from its keys), so a new
 * event type cannot exist without saying what it delivers: an event added with
 * a default would silently ship a PaymentIntent to a consumer expecting
 * something else — which typechecks on both sides and fails only in production.
 *
 * The `payment_intent.*` events follow the status the intent reached
 * (ADR 0019): `created` when it is minted, then one per transition —
 * `requires_action`, `processing`, `amount_capturable_updated` (authorized,
 * awaiting capture), `succeeded`, `payment_failed` (an attempt failed; a card
 * returns to `requires_payment_method`, a FairCoin underpayment is also
 * `canceled`) and `canceled` (by the merchant, by expiry — `abandoned` — or
 * underpaid).
 *
 * Refunds are not PaymentIntent statuses: `refund.created|updated|failed` carry
 * the Refund, and `charge.refunded` the Charge whose `amount_refunded` moved.
 * A dispute is the network's process beside a payment that stays `succeeded`:
 * `charge.dispute.created` is a DEADLINE (evidence is due), `closed` carries
 * the outcome.
 */
export interface WebhookEventPayload {
  'payment_intent.created': PaymentIntent;
  'payment_intent.requires_action': PaymentIntent;
  'payment_intent.processing': PaymentIntent;
  'payment_intent.amount_capturable_updated': PaymentIntent;
  'payment_intent.succeeded': PaymentIntent;
  'payment_intent.payment_failed': PaymentIntent;
  'payment_intent.canceled': PaymentIntent;
  'charge.refunded': Charge;
  'charge.dispute.created': Dispute;
  'charge.dispute.updated': Dispute;
  'charge.dispute.closed': Dispute;
  'refund.created': Refund;
  'refund.updated': Refund;
  'refund.failed': Refund;
  'customer.created': Customer;
  'customer.updated': Customer;
  'customer.deleted': Customer;
  'payment_method.attached': PaymentMethod;
  'payment_method.detached': PaymentMethod;
  'payment_method.updated': PaymentMethod;
  'setup_intent.created': SetupIntent;
  'setup_intent.requires_action': SetupIntent;
  'setup_intent.succeeded': SetupIntent;
  'setup_intent.setup_failed': SetupIntent;
  'setup_intent.canceled': SetupIntent;
  /**
   * The catalog (ADR 0018): each create, update and delete of a product,
   * price, coupon or promotion code, carrying the object as it stands after
   * the change (a deleted one as it stood before). An update names the moved
   * fields in `data.previous_attributes`; an update that moved nothing records
   * no event. Prices and promotion codes are never deleted — they are archived
   * with `active: false` — so there is no `price.deleted` or
   * `promotion_code.deleted`: a type that can never be sent is a promise the
   * catalog cannot keep.
   */
  'product.created': Product;
  'product.updated': Product;
  'product.deleted': Product;
  'price.created': Price;
  'price.updated': Price;
  'coupon.created': Coupon;
  'coupon.updated': Coupon;
  'coupon.deleted': Coupon;
  'promotion_code.created': PromotionCode;
  'promotion_code.updated': PromotionCode;
  /**
   * A seller's account changed — their READINESS, in practice. Emitted when the
   * fields a merchant ACTS on change, not on every refresh. It names no payment
   * intent.
   */
  'connected_account.updated': ConnectedAccount;
  'billing.observation.updated': BillingObservation;
  /**
   * A synthetic event sent to ONE endpoint when its owner asks to test it
   * (Orbit's "send test event"). Stored like any other event, but it never fans
   * out and it cannot be subscribed to: `enabled_events` refuses it. The
   * endpoint being tested, as `GET /v1/webhook_endpoints/:id` returns it.
   */
  'webhook_endpoint.test': WebhookEndpoint;
}

/** Every event type, Stripe's names. */
export type WebhookEventType = keyof WebhookEventPayload;

/**
 * What caused an event, when an API request did (Stripe's `event.request`).
 * Both `null` for an event caused by something else — the chain watcher, the
 * expiry sweeper, a provider's own notification.
 */
export interface WebhookEventRequest {
  /** The `Request-Id` of the request whose change produced the event. */
  id: string | null;
  /** The `Idempotency-Key` that request carried, if any. */
  idempotency_key: string | null;
}

/**
 * One delivered event.
 *
 * A DISCRIMINATED union over every event type, so `data.object` is narrowed by
 * a switch on `type` with no cast:
 *
 * ```ts
 * if (event.type === 'charge.dispute.created') {
 *   event.data.object.evidence_due_at; // Dispute, not PaymentIntent
 * }
 * ```
 *
 * The parameter narrows to a subset of event types —
 * `WebhookEvent<'payment_intent.succeeded'>` is that event alone.
 */
export type WebhookEvent<K extends WebhookEventType = WebhookEventType> = {
  [T in K]: {
    id: string;
    object: 'event';
    /** The mode of the merchant it was sent to, and of the object it carries (ADR 0017). */
    livemode: boolean;
    type: T;
    created: number;
    /**
     * The connected account (`ca_…`) this event is about — Stripe's
     * `event.account` (ADR 0012 D7). Present on every event for an on-behalf
     * payment and on `connected_account.updated`; absent otherwise.
     */
    account?: string;
    /**
     * The wire version the event was rendered with — the `Peable-Version` of
     * the deployment that stored it. An event is a stored snapshot; it is not
     * re-rendered when the wire moves on.
     */
    api_version: string;
    data: {
      object: WebhookEventPayload[T];
      /**
       * The fields of `object` that this change moved, with their values
       * BEFORE it. Absent when the event is not a change of an existing object.
       */
      previous_attributes?: Record<string, unknown>;
    };
    request: WebhookEventRequest;
  };
}[K];
