// Event envelope — Stripe's event names (ADR 0019) with the resource object
// nested under `data.object`. Stored once (`/v1/events`, 30 days) and delivered
// HMAC-signed to every matching webhook endpoint (ADR 0014 D4).
import type { Account } from './account';
import type { ApplicationFee, Balance, Payout } from './balance';
import type { Charge } from './charge';
import type { CheckoutSession } from './checkoutSession';
import type { Coupon, Price, Product, PromotionCode } from './catalog';
import type { Customer } from './customer';
import type { Dispute } from './dispute';
import type { PaymentIntent } from './paymentIntent';
import type { PaymentLink } from './paymentLink';
import type { PaymentMethod } from './paymentMethod';
import type { ReportRun } from './reporting';
import type { ConnectedAccount, Refund } from './settlement';
import type { SetupIntent } from './setupIntent';
import type { WebhookEndpoint } from './webhookEndpoint';
import type { Subscription } from './subscription';
import type { CreditNote, Invoice, InvoiceItem } from './invoice';
import type {
  ActiveEntitlementSummary,
  BillingMeter,
  BillingPortalConfiguration,
  BillingPortalSession,
  TestClock,
} from './billingEngine';

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
 * `charge.dispute.created` is a DEADLINE (evidence is due), `updated` follows
 * a staged or submitted response, `closed` carries the outcome, and
 * `funds_withdrawn` / `funds_reinstated` the money's movement — never the
 * evidence, which is not stored and so is never in an event.
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
  /** The network took the disputed amount from the balance. */
  'charge.dispute.funds_withdrawn': Dispute;
  /** The network returned it (the dispute was won, or withdrawn by the cardholder). */
  'charge.dispute.funds_reinstated': Dispute;
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
   * Checkout (Orbit Phase 3). `completed` when the payer finished: the payment
   * succeeded (`payment_status: paid`), was authorized for a manual capture,
   * or — a FairCoin payment — was broadcast and is confirming (`unpaid`), in
   * which case `async_payment_succeeded` or `async_payment_failed` follows
   * when the chain decides. `expired` when it ran out or the merchant expired
   * it. Each carries the session as `GET /v1/checkout_sessions/:id` returns it.
   */
  'checkout.session.completed': CheckoutSession;
  'checkout.session.expired': CheckoutSession;
  'checkout.session.async_payment_succeeded': CheckoutSession;
  'checkout.session.async_payment_failed': CheckoutSession;
  'payment_link.created': PaymentLink;
  'payment_link.updated': PaymentLink;
  /**
   * The native billing engine (ADR 0018). Every status change of a
   * subscription or an invoice is recorded in the transaction that makes it,
   * with `previous_attributes` naming what moved.
   *
   * `customer.subscription.trial_will_end` is sent three days before a trial
   * ends; `paused` / `resumed` are the `paused` STATUS (a trial that ended with
   * no payment method), not `pause_collection`, which is an `updated`.
   */
  'customer.subscription.created': Subscription;
  'customer.subscription.updated': Subscription;
  'customer.subscription.deleted': Subscription;
  'customer.subscription.trial_will_end': Subscription;
  'customer.subscription.paused': Subscription;
  'customer.subscription.resumed': Subscription;
  /**
   * `invoice.upcoming` is sent a few days before a renewal (the invoice it
   * carries is a preview, `id` empty, never stored); `invoice.sent` when the
   * invoice is emailed to the customer.
   */
  'invoice.created': Invoice;
  'invoice.updated': Invoice;
  'invoice.deleted': Invoice;
  'invoice.finalized': Invoice;
  'invoice.paid': Invoice;
  'invoice.payment_failed': Invoice;
  'invoice.payment_action_required': Invoice;
  'invoice.voided': Invoice;
  'invoice.marked_uncollectible': Invoice;
  'invoice.upcoming': Invoice;
  'invoice.sent': Invoice;
  'invoiceitem.created': InvoiceItem;
  'invoiceitem.deleted': InvoiceItem;
  'credit_note.created': CreditNote;
  'credit_note.updated': CreditNote;
  'credit_note.voided': CreditNote;
  'test_helpers.test_clock.created': TestClock;
  'test_helpers.test_clock.advancing': TestClock;
  'test_helpers.test_clock.ready': TestClock;
  'test_helpers.test_clock.deleted': TestClock;
  'billing.meter.created': BillingMeter;
  'billing.meter.updated': BillingMeter;
  'billing.meter.deactivated': BillingMeter;
  'billing.meter.reactivated': BillingMeter;
  /** A customer's active entitlements changed — re-read them, then grant or withdraw access. */
  'entitlements.active_entitlement_summary.updated': ActiveEntitlementSummary;
  'billing_portal.configuration.created': BillingPortalConfiguration;
  'billing_portal.configuration.updated': BillingPortalConfiguration;
  'billing_portal.session.created': BillingPortalSession;
  /**
   * A seller's account changed — their READINESS, in practice. Emitted when the
   * fields a merchant ACTS on change, not on every refresh. It names no payment
   * intent.
   */
  'connected_account.updated': ConnectedAccount;
  /**
   * The merchant's OWN fiat account changed (ADR 0015 §1) — readiness,
   * requirements, settings. Emitted when a field the merchant acts on moved.
   */
  'account.updated': Account;
  /** Orbit's fee was taken on a succeeded charge (ADR 0015 §3). */
  'application_fee.created': ApplicationFee;
  /** Part or all of a fee went back (a refund with `refund_application_fee`). */
  'application_fee.refunded': ApplicationFee;
  /** A payout of the merchant's account, mirrored from the provider (ADR 0015 §5). */
  'payout.created': Payout;
  'payout.updated': Payout;
  'payout.paid': Payout;
  'payout.failed': Payout;
  'payout.canceled': Payout;
  /** Funds became available in the account; carries the balance read from the ledger. */
  'balance.available': Balance;
  /** A report run finished: its CSV is `result` (a `finance_report_run` file). */
  'reporting.report_run.succeeded': ReportRun;
  /** A report run could not be produced; `error` says why. */
  'reporting.report_run.failed': ReportRun;
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
