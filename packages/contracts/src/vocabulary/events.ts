// The event vocabulary (ADR 0014 D4, ADR 0019): every event type the gateway
// emits and the `object` type its `data.object` carries. Zod-free, so the SDK's
// signature check, the CLI and the backend's CHECK constraints read the same
// closed set without constructing a schema.

/**
 * Event type → the `object` value of the resource under `data.object`.
 *
 * TOTAL and the ONLY list: {@link WEBHOOK_EVENT_TYPES} is its keys, so a new
 * event type cannot exist without saying what it delivers — an event added
 * with a default would silently ship a PaymentIntent to a consumer expecting
 * something else, which typechecks on both sides and fails only in production.
 * The precise payload TYPE is `WebhookEventPayload` (`resources/events`), the
 * registered object of each value.
 *
 * The order is the database's: the backend's CHECK constraints list the types
 * in this order, so reordering it is a migration.
 *
 * - `payment_intent.*` follow the status the intent reached (ADR 0019):
 *   `created` when it is minted, then one per transition — `requires_action`,
 *   `processing`, `amount_capturable_updated` (authorized, awaiting capture),
 *   `succeeded`, `payment_failed` (an attempt failed; a card returns to
 *   `requires_payment_method`, a FairCoin underpayment is also `canceled`) and
 *   `canceled` (by the merchant, by expiry — `abandoned` — or underpaid).
 * - Refunds are not PaymentIntent statuses: `refund.*` carry the Refund, and
 *   `charge.refunded` the Charge whose `amount_refunded` moved.
 * - A dispute is the network's process beside a payment that stays
 *   `succeeded`; its events carry the Dispute, never the evidence (which is not
 *   stored).
 * - The catalog has no `price.deleted` or `promotion_code.deleted`: those are
 *   archived with `active: false`, and a type that can never be sent is a
 *   promise the catalog cannot keep.
 */
export const WEBHOOK_EVENT_OBJECTS = {
  'payment_intent.created': 'payment_intent',
  'payment_intent.requires_action': 'payment_intent',
  'payment_intent.processing': 'payment_intent',
  'payment_intent.amount_capturable_updated': 'payment_intent',
  'payment_intent.succeeded': 'payment_intent',
  'payment_intent.payment_failed': 'payment_intent',
  'payment_intent.canceled': 'payment_intent',
  'charge.refunded': 'charge',
  'charge.dispute.created': 'dispute',
  'charge.dispute.updated': 'dispute',
  'charge.dispute.closed': 'dispute',
  'charge.dispute.funds_withdrawn': 'dispute',
  'charge.dispute.funds_reinstated': 'dispute',
  'refund.created': 'refund',
  'refund.updated': 'refund',
  'refund.failed': 'refund',
  'customer.created': 'customer',
  'customer.updated': 'customer',
  'customer.deleted': 'customer',
  'payment_method.attached': 'payment_method',
  'payment_method.detached': 'payment_method',
  'payment_method.updated': 'payment_method',
  'setup_intent.created': 'setup_intent',
  'setup_intent.requires_action': 'setup_intent',
  'setup_intent.succeeded': 'setup_intent',
  'setup_intent.setup_failed': 'setup_intent',
  'setup_intent.canceled': 'setup_intent',
  'connected_account.updated': 'connected_account',
  'product.created': 'product',
  'product.updated': 'product',
  'product.deleted': 'product',
  'price.created': 'price',
  'price.updated': 'price',
  'coupon.created': 'coupon',
  'coupon.updated': 'coupon',
  'coupon.deleted': 'coupon',
  'promotion_code.created': 'promotion_code',
  'promotion_code.updated': 'promotion_code',
  'account.updated': 'account',
  'application_fee.created': 'application_fee',
  'application_fee.refunded': 'application_fee',
  'payout.created': 'payout',
  'payout.updated': 'payout',
  'payout.paid': 'payout',
  'payout.failed': 'payout',
  'payout.canceled': 'payout',
  'balance.available': 'balance',
  'checkout.session.completed': 'checkout_session',
  'checkout.session.expired': 'checkout_session',
  'checkout.session.async_payment_succeeded': 'checkout_session',
  'checkout.session.async_payment_failed': 'checkout_session',
  'payment_link.created': 'payment_link',
  'payment_link.updated': 'payment_link',
  'reporting.report_run.succeeded': 'reporting.report_run',
  'reporting.report_run.failed': 'reporting.report_run',
  'customer.subscription.created': 'subscription',
  'customer.subscription.updated': 'subscription',
  'customer.subscription.deleted': 'subscription',
  'customer.subscription.trial_will_end': 'subscription',
  'customer.subscription.paused': 'subscription',
  'customer.subscription.resumed': 'subscription',
  'invoice.created': 'invoice',
  'invoice.updated': 'invoice',
  'invoice.deleted': 'invoice',
  'invoice.finalized': 'invoice',
  'invoice.paid': 'invoice',
  'invoice.payment_failed': 'invoice',
  'invoice.payment_action_required': 'invoice',
  'invoice.voided': 'invoice',
  'invoice.marked_uncollectible': 'invoice',
  'invoice.upcoming': 'invoice',
  'invoice.sent': 'invoice',
  'invoiceitem.created': 'invoiceitem',
  'invoiceitem.deleted': 'invoiceitem',
  'credit_note.created': 'credit_note',
  'credit_note.updated': 'credit_note',
  'credit_note.voided': 'credit_note',
  'test_helpers.test_clock.created': 'test_helpers.test_clock',
  'test_helpers.test_clock.advancing': 'test_helpers.test_clock',
  'test_helpers.test_clock.ready': 'test_helpers.test_clock',
  'test_helpers.test_clock.deleted': 'test_helpers.test_clock',
  'billing.meter.created': 'billing.meter',
  'billing.meter.updated': 'billing.meter',
  'billing.meter.deactivated': 'billing.meter',
  'billing.meter.reactivated': 'billing.meter',
  'entitlements.active_entitlement_summary.updated': 'entitlements.active_entitlement_summary',
  'billing_portal.configuration.created': 'billing_portal.configuration',
  'billing_portal.configuration.updated': 'billing_portal.configuration',
  'billing_portal.session.created': 'billing_portal.session',
  'tax.assessment.created': 'tax.assessment',
  'tax.review_item.created': 'tax.review_item',
  'tax.review_item.updated': 'tax.review_item',
  'webhook_endpoint.test': 'webhook_endpoint',
} as const;

/** Every event type, Stripe's names (ADR 0019). */
export type WebhookEventType = keyof typeof WEBHOOK_EVENT_OBJECTS;

/** The `object` type an event of type `T` carries under `data.object`. */
export type WebhookEventObjectType<T extends WebhookEventType = WebhookEventType> =
  (typeof WEBHOOK_EVENT_OBJECTS)[T];

/** Every event type, in {@link WEBHOOK_EVENT_OBJECTS} order. */
export const WEBHOOK_EVENT_TYPES = Object.keys(WEBHOOK_EVENT_OBJECTS) as [
  WebhookEventType,
  ...WebhookEventType[],
];

/**
 * The event types never fanned out by subscription — sent only to the one
 * endpoint they name. `enabled_events` refuses them.
 */
export const TARGETED_WEBHOOK_EVENT_TYPES = [
  'webhook_endpoint.test',
] as const satisfies readonly WebhookEventType[];
export type TargetedWebhookEventType = (typeof TARGETED_WEBHOOK_EVENT_TYPES)[number];

/** `'*'` subscribes to every event type, including ones added later. */
export type WebhookEnabledEvent = Exclude<WebhookEventType, TargetedWebhookEventType> | '*';

/** What `enabled_events` may hold: `*`, then every subscribable type. */
export const WEBHOOK_ENABLED_EVENTS = [
  '*',
  ...WEBHOOK_EVENT_TYPES.filter(
    (type): type is Exclude<WebhookEventType, TargetedWebhookEventType> =>
      !(TARGETED_WEBHOOK_EVENT_TYPES as readonly string[]).includes(type),
  ),
] as [WebhookEnabledEvent, ...WebhookEnabledEvent[]];

export const WEBHOOK_ENDPOINT_STATUSES = ['enabled', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

/**
 * Why an endpoint is `disabled`.
 *
 *  - `disabled_by_merchant` — its owner set `disabled: true`.
 *  - `delivery_failures`    — every delivery to it failed for three days
 *    straight, so Peable stopped sending. Re-enabling it (`disabled: false`)
 *    starts the clock again.
 */
export const WEBHOOK_ENDPOINT_DISABLED_REASONS = [
  'disabled_by_merchant',
  'delivery_failures',
] as const;
export type WebhookEndpointDisabledReason = (typeof WEBHOOK_ENDPOINT_DISABLED_REASONS)[number];

/** At most this many endpoints per merchant (per mode). */
export const WEBHOOK_ENDPOINTS_MAX_PER_MERCHANT = 16;

/** The longest an endpoint's `description` may be. */
export const WEBHOOK_ENDPOINT_DESCRIPTION_MAX = 5000;

/** The longest a rolled secret may keep signing beside its replacement. */
export const WEBHOOK_SECRET_ROLL_MAX_EXPIRES_IN_SECONDS = 24 * 60 * 60;

/**
 * Where one webhook delivery stands (ADR 0001 D7).
 *
 *  - `pending`   — will be attempted. `next_attempt_at` says when.
 *  - `delivered` — terminal success.
 *  - `failed`    — the endpoint REFUSED it (a 4xx, a blocked address), or the
 *                  endpoint was disabled before it could be attempted. No retry
 *                  can fix that, so none is made.
 *  - `dead`      — every attempt failed transiently over three days and the
 *                  budget ran out. It can be redelivered by hand.
 */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];
