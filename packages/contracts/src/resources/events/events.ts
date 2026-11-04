import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type ObjectMap, resolveObject } from '../../common/objects';
import { idParam, listQuery, queryBoolean, retrieveQuery } from '../../common/params';
import { livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  WEBHOOK_EVENT_OBJECTS,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventObjectType,
  type WebhookEventType,
} from '../../vocabulary/events';

/**
 * Events (`evt_…`, ADR 0014 D4) — Stripe's event names (ADR 0019) with the
 * resource nested under `data.object`. Stored once, in the transaction of the
 * change it records, kept 30 days (`/v1/events`), and delivered HMAC-signed to
 * every matching webhook endpoint: a delivery's body and `GET /v1/events/:id`
 * are byte for byte the same object.
 */

/**
 * What caused an event, when an API request did (Stripe's `event.request`).
 * Both `null` for an event caused by something else — the chain watcher, the
 * expiry sweeper, a provider's own notification.
 */
export const eventRequestSchema = defineComponent(
  'EventRequest',
  z
    .object({
      id: z
        .string()
        .nullable()
        .describe('The `Request-Id` of the request whose change produced the event.'),
      idempotency_key: z
        .string()
        .nullable()
        .describe('The `Idempotency-Key` that request carried, if any.'),
    })
    .strict(),
);
export type WebhookEventRequest = z.output<typeof eventRequestSchema>;

const previousAttributes = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'The fields of `object` that this change moved, with their values BEFORE it. Absent when the event is not a change of an existing object.',
  );

/**
 * The fields of the envelope that do not depend on its type, in the wire's
 * order around `type` and `data` (`lib/serialize.ts` `toEventDTO`).
 */
const head = {
  id: z.string().describe('`evt_…`.'),
  object: z.literal('event'),
};
const tail = {
  created: unixSeconds,
  livemode: livemode.describe(
    'The mode of the merchant it was sent to, and of the object it carries (ADR 0017).',
  ),
  api_version: z
    .string()
    .describe(
      'The wire version the event was rendered with — the `Peable-Version` of the deployment that stored it. An event is a stored snapshot; it is not re-rendered when the wire moves on.',
    ),
  account: z
    .string()
    .optional()
    .describe(
      'The connected account (`ca_…`) this event is about (ADR 0012 D7). Present on every event for an on-behalf payment and on `connected_account.updated`; absent otherwise.',
    ),
};

/** The envelope around `type` and `data.object`. */
function envelope<T extends z.ZodType, O extends z.ZodType>(type: T, object: O) {
  return z
    .object({
      ...head,
      type,
      ...tail,
      data: z.object({ object, previous_attributes: previousAttributes }).strict(),
      request: eventRequestSchema,
    })
    .strict();
}

/** The schema of the object an event of `type` carries, once its module registered it. */
const objectOf = (type: WebhookEventType) =>
  z.lazy(() => resolveObject(WEBHOOK_EVENT_OBJECTS[type]));

/** Every object type an event can carry, each once. */
const EVENT_OBJECT_TYPES = [...new Set(Object.values(WEBHOOK_EVENT_OBJECTS))];

/**
 * An event of any type. `data.object` is the resource `type` names
 * (`WEBHOOK_EVENT_OBJECTS`), checked against THAT object's schema — a
 * `payment_intent.succeeded` carrying a Customer is refused even though a
 * Customer is a valid event object.
 */
export const eventSchema = defineObject(
  'event',
  'Event',
  envelope(
    z.enum(WEBHOOK_EVENT_TYPES),
    z
      .union(EVENT_OBJECT_TYPES.map((type) => z.lazy(() => resolveObject(type))))
      .describe('The resource the event is about, as the API rendered it at the time.'),
  ).superRefine((event, ctx) => {
    const expected = WEBHOOK_EVENT_OBJECTS[event.type];
    const parsed = resolveObject(expected).safeParse(event.data.object);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'object', ...issue.path],
        message: `a ${event.type} event carries a ${expected}: ${issue.message}`,
      });
    }
  }),
  {
    examples: [
      {
        id: 'evt_0193b8f2c1a87d3e9f4b',
        object: 'event',
        type: 'webhook_endpoint.test',
        created: 1793750400,
        livemode: false,
        api_version: '2026-11-03',
        data: {
          object: {
            id: 'we_0193b8f2c1a87d3e9f4c',
            object: 'webhook_endpoint',
            livemode: false,
            url: 'https://example.com/peable/webhooks',
            description: null,
            enabled_events: ['*'],
            status: 'enabled',
            disabled_reason: null,
            api_version: '2026-11-03',
            metadata: {},
            created: 1793750000,
            updated_at: 1793750000,
          },
        },
        request: { id: 'req_0193b8f2c1a87d3e9f4d', idempotency_key: null },
      },
    ],
  },
);

/**
 * The envelope of one event type, `data.object` narrowed to its object: the
 * request body of that type's webhook in the OpenAPI document.
 */
export function eventSchemaOf<T extends WebhookEventType>(type: T) {
  return envelope(z.literal(type), objectOf(type));
}

/** The object an event of an object type carries, as its module registered it. */
type EventObject<K extends string> = K extends keyof ObjectMap ? ObjectMap[K] : never;

/**
 * Which resource each event type carries under `data.object` — TOTAL over
 * {@link WebhookEventType}, derived from `WEBHOOK_EVENT_OBJECTS`, so a new
 * event type cannot exist without saying what it delivers.
 */
export type WebhookEventPayload = {
  [T in WebhookEventType]: EventObject<WebhookEventObjectType<T>>;
};

type EventEnvelope = z.output<ReturnType<typeof envelope<z.ZodString, z.ZodUnknown>>>;

/**
 * One delivered event.
 *
 * A DISCRIMINATED union over every event type, so `data.object` is narrowed by
 * a switch on `type` with no cast:
 *
 * ```ts
 * if (event.type === 'charge.dispute.created') {
 *   event.data.object.evidence_details; // Dispute, not PaymentIntent
 * }
 * ```
 *
 * The parameter narrows to a subset of event types —
 * `WebhookEvent<'payment_intent.succeeded'>` is that event alone.
 */
export type WebhookEvent<K extends WebhookEventType = WebhookEventType> = {
  [T in K]: {
    [P in keyof EventEnvelope]: P extends 'type'
      ? T
      : P extends 'data'
        ? {
            object: WebhookEventPayload[T];
            previous_attributes?: Record<string, unknown>;
          }
        : EventEnvelope[P];
  };
}[K];

declare module '../../common/objects' {
  interface ObjectMap {
    event: WebhookEvent;
  }
}

/**
 * `type=payment_intent.settled` (exact) or `type=payment_intent.*` (a dotted
 * prefix). `*` alone is no filter. Lowercase dotted names only, so the value is
 * never a LIKE pattern of the caller's choosing.
 */
const TYPE_FILTER_PATTERN = /^(\*|[a-z_]+(\.[a-z_]+)*(\.\*)?)$/;

/** An event type filter as the repository reads it; `undefined` is every type. */
export type EventTypeFilter =
  | { readonly kind: 'exact'; readonly type: string }
  | { readonly kind: 'prefix'; readonly prefix: string };

function toTypeFilter(value: string): EventTypeFilter | undefined {
  if (value === '*') return undefined;
  if (value.endsWith('.*')) return { kind: 'prefix', prefix: value.slice(0, -1) };
  return { kind: 'exact', type: value };
}

const typeFilter = z
  .string()
  .max(100)
  .regex(TYPE_FILTER_PATTERN, 'type is an event type, or a prefix ending in .* (payment_intent.*)')
  .transform(toTypeFilter);

/** The filters `GET /v1/events` adds to the list parameters. */
export const listEventsFilters = {
  type: typeFilter
    .optional()
    .describe('An exact event type, or a prefix ending in `.*` (`payment_intent.*`).'),
  delivery_success: queryBoolean
    .optional()
    .describe(
      '`true`: only events every delivery of which succeeded. `false`: only events with a delivery still pending or failed.',
    ),
  payment_intent: idParam
    .optional()
    .describe('`pi_…`: only the events about that payment — the timeline of one payment.'),
};

export const listEventsQuery = listQuery(listEventsFilters);
export type ListEventsParams = z.input<typeof listEventsQuery>;

export const retrieveEventQuery = retrieveQuery({});
export type RetrieveEventParams = z.input<typeof retrieveEventQuery>;

/**
 * The stream's `types`: a comma-separated list of the same filters
 * (`payment_intent.settled,connected_account.*`). Absent, or any `*`, is every
 * event.
 */
export const streamEventsQuery = z
  .object({
    types: z
      .string()
      .max(2_000)
      .transform((value) => value.split(',').map((part) => part.trim()))
      .pipe(
        z
          .array(
            z
              .string()
              .max(100)
              .regex(
                TYPE_FILTER_PATTERN,
                'types is a comma-separated list of event types, or prefixes ending in .*',
              )
              .transform(toTypeFilter),
          )
          .min(1)
          .max(32),
      )
      .optional()
      .describe(
        'Comma-separated event types or `prefix.*` patterns (`payment_intent.succeeded,charge.*`). Absent: every event.',
      ),
  })
  .strict();
export type StreamEventsParams = z.input<typeof streamEventsQuery>;

/** One line per event type: what happened when it is sent. Total, like the vocabulary. */
export const WEBHOOK_EVENT_DESCRIPTIONS: Readonly<Record<WebhookEventType, string>> = {
  'payment_intent.created': 'A PaymentIntent was created.',
  'payment_intent.requires_action': 'A PaymentIntent needs the payer to act (pay, authenticate).',
  'payment_intent.processing':
    'A PaymentIntent is processing: a FairCoin payment was broadcast, or a card payment is pending.',
  'payment_intent.amount_capturable_updated':
    'A PaymentIntent was authorized and awaits capture (`capture_method: manual`).',
  'payment_intent.succeeded': 'A PaymentIntent succeeded: the payment is final.',
  'payment_intent.payment_failed':
    'A payment attempt failed; a card PaymentIntent returns to `requires_payment_method`.',
  'payment_intent.canceled':
    'A PaymentIntent was canceled — by the merchant, by expiry, or underpaid.',
  'charge.refunded': 'A Charge was refunded, partially or fully: `amount_refunded` moved.',
  'charge.dispute.created': 'A cardholder disputed a charge. Evidence is due by its deadline.',
  'charge.dispute.updated': 'A Dispute changed: evidence was staged or submitted.',
  'charge.dispute.closed': 'A Dispute closed; `status` carries the outcome.',
  'charge.dispute.funds_withdrawn': 'The network took the disputed amount from the balance.',
  'charge.dispute.funds_reinstated':
    'The network returned the disputed amount (the dispute was won, or withdrawn).',
  'refund.created': 'A Refund was created.',
  'refund.updated': 'A Refund changed state.',
  'refund.failed': 'A Refund failed: the bank rejected it.',
  'customer.created': 'A Customer was created.',
  'customer.updated': 'A Customer was updated; `previous_attributes` names what moved.',
  'customer.deleted': 'A Customer was deleted.',
  'payment_method.attached': 'A PaymentMethod was attached to a Customer.',
  'payment_method.detached': 'A PaymentMethod was detached from its Customer.',
  'payment_method.updated': 'A PaymentMethod was updated.',
  'setup_intent.created': 'A SetupIntent was created.',
  'setup_intent.requires_action': 'A SetupIntent needs the customer to authenticate.',
  'setup_intent.succeeded': 'A SetupIntent succeeded: its PaymentMethod is saved.',
  'setup_intent.setup_failed': 'A SetupIntent attempt failed.',
  'setup_intent.canceled': 'A SetupIntent was canceled.',
  'connected_account.updated': "A seller's connected account changed — its readiness, in practice.",
  'product.created': 'A Product was created.',
  'product.updated': 'A Product was updated; `previous_attributes` names what moved.',
  'product.deleted': 'A Product was deleted (it carries the product as it stood before).',
  'price.created': 'A Price was created.',
  'price.updated': 'A Price was updated (archiving one is `active: false`).',
  'coupon.created': 'A Coupon was created.',
  'coupon.updated': 'A Coupon was updated.',
  'coupon.deleted': 'A Coupon was deleted.',
  'promotion_code.created': 'A PromotionCode was created.',
  'promotion_code.updated': 'A PromotionCode was updated (archiving one is `active: false`).',
  'account.updated': "The merchant's own account changed: readiness, requirements or settings.",
  'application_fee.created': "Orbit's fee was taken on a succeeded charge.",
  'application_fee.refunded': 'Part or all of an application fee went back.',
  'payout.created': 'A Payout was created.',
  'payout.updated': 'A Payout changed.',
  'payout.paid': 'A Payout arrived in the bank account.',
  'payout.failed': 'A Payout failed.',
  'payout.canceled': 'A Payout was canceled.',
  'balance.available': 'Funds became available in the balance.',
  'checkout.session.completed':
    'The payer finished a Checkout Session (paid, authorized, or a FairCoin payment confirming).',
  'checkout.session.expired': 'A Checkout Session expired, or the merchant expired it.',
  'checkout.session.async_payment_succeeded':
    "A completed Checkout Session's FairCoin payment confirmed.",
  'checkout.session.async_payment_failed':
    "A completed Checkout Session's FairCoin payment failed.",
  'payment_link.created': 'A PaymentLink was created.',
  'payment_link.updated': 'A PaymentLink was updated.',
  'reporting.report_run.succeeded': 'A ReportRun finished: its CSV is `result`.',
  'reporting.report_run.failed': 'A ReportRun could not be produced; `error` says why.',
  'customer.subscription.created': 'A Subscription was created.',
  'customer.subscription.updated':
    'A Subscription changed; `previous_attributes` names what moved.',
  'customer.subscription.deleted': 'A Subscription ended.',
  'customer.subscription.trial_will_end': "A Subscription's trial ends in three days.",
  'customer.subscription.paused':
    'A Subscription was paused (a trial ended with no payment method).',
  'customer.subscription.resumed': 'A paused Subscription resumed.',
  'invoice.created': 'An Invoice was created.',
  'invoice.updated': 'An Invoice changed.',
  'invoice.deleted': 'A draft Invoice was deleted.',
  'invoice.finalized': 'An Invoice was finalized.',
  'invoice.paid': 'An Invoice was paid.',
  'invoice.payment_failed': 'An attempt to pay an Invoice failed.',
  'invoice.payment_action_required': 'Paying an Invoice needs the customer to act.',
  'invoice.voided': 'An Invoice was voided.',
  'invoice.marked_uncollectible': 'An Invoice was marked uncollectible.',
  'invoice.upcoming': 'A renewal is days away; it carries a preview Invoice (`id` empty).',
  'invoice.sent': 'An Invoice was emailed to the customer.',
  'invoiceitem.created': 'An InvoiceItem was created.',
  'invoiceitem.deleted': 'An InvoiceItem was deleted.',
  'credit_note.created': 'A CreditNote was issued.',
  'credit_note.updated': 'A CreditNote was updated.',
  'credit_note.voided': 'A CreditNote was voided.',
  'test_helpers.test_clock.created': 'A test clock was created.',
  'test_helpers.test_clock.advancing': 'A test clock started advancing.',
  'test_helpers.test_clock.ready': 'A test clock finished advancing.',
  'test_helpers.test_clock.deleted': 'A test clock was deleted.',
  'billing.meter.created': 'A billing Meter was created.',
  'billing.meter.updated': 'A billing Meter was updated.',
  'billing.meter.deactivated': 'A billing Meter was deactivated.',
  'billing.meter.reactivated': 'A billing Meter was reactivated.',
  'entitlements.active_entitlement_summary.updated':
    "A customer's active entitlements changed — re-read them, then grant or withdraw access.",
  'billing_portal.configuration.created': 'A customer portal configuration was created.',
  'billing_portal.configuration.updated': 'A customer portal configuration was updated.',
  'billing_portal.session.created': 'A customer portal session was created.',
  'tax.assessment.created':
    'A tax compliance assessment was run. Nothing was registered, filed or collected.',
  'tax.review_item.created': 'A tax assessment finding opened a review item.',
  'tax.review_item.updated': 'A tax review item was decided, or found again.',
  'webhook_endpoint.test':
    'A test event, sent to ONE endpoint when its owner asks. It cannot be subscribed to.',
};

export const eventRoutes = [
  defineRoute({
    operationId: 'listEvents',
    method: 'get',
    path: '/v1/events',
    tag: 'Events',
    summary: 'List events',
    description:
      'Every event of the last 30 days, newest first, rendered exactly as its webhook deliveries carried it.',
    auth: 'service',
    scope: 'payments:read',
    query: listEventsQuery,
    response: listOf(eventSchema),
    sdk: 'events.list',
    expandable: 'event',
  }),
  defineRoute({
    operationId: 'streamEvents',
    method: 'get',
    path: '/v1/events/stream',
    tag: 'Events',
    summary: 'Stream events',
    description:
      'Server-Sent Events: every event of this merchant as it commits, rendered exactly as a webhook delivery carries it (`event: event`, `id:` the `evt_…`). Resumes after `Last-Event-ID`. Test mode only — what `peable listen` forwards to a local server.',
    auth: 'service',
    scope: 'payments:read',
    testModeOnly: true,
    query: streamEventsQuery,
    response: { kind: 'stream', event: eventSchema },
    sdk: 'events.stream',
  }),
  defineRoute({
    operationId: 'retrieveEvent',
    method: 'get',
    path: '/v1/events/{id}',
    tag: 'Events',
    summary: 'Retrieve an event',
    description: 'A `404` once the event is older than 30 days.',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The event (`evt_…`).' },
    query: retrieveEventQuery,
    response: eventSchema,
    sdk: 'events.retrieve',
    expandable: 'event',
  }),
] as const;
