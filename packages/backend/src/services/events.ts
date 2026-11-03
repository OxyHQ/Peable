/**
 * Recording an event — the one writer of `events` (ADR 0014 D4).
 *
 * An event is stored ONCE, in the transaction of the change it records, and
 * fanned out in that same transaction to every enabled webhook endpoint of the
 * merchant whose `enabled_events` match it (ADR 0001 D7). Whether any endpoint
 * wants it does not decide whether it exists: `/v1/events` is the record, and
 * a merchant with no endpoint can still read what happened.
 *
 * Every producer goes through `recordEvent`: intent transitions, disputes,
 * connected-account readiness, billing observations, and the synthetic test
 * event. A new producer that wrote a delivery directly would be an event the
 * events API never shows.
 */
import {
  PEABLE_API_VERSION,
  type WebhookEndpoint,
  type WebhookEventPayload,
  type WebhookEventType,
} from '@peable.to/shared-types';
import { insertEvent, type EventRow } from '../db/events/eventRepository';
import type { DatabaseOrTransaction } from '../db/postgres';
import { enqueueDelivery, enqueueEventDeliveries } from '../db/webhooks/webhookOutboxRepository';
import type { WebhookEndpointRow } from '../db/webhooks/webhookEndpointRepository';
import { TARGETED_WEBHOOK_EVENT_TYPES } from '../db/schema/valueSets';
import { newId } from '../lib/ids';
import { currentEventRequest } from '../lib/requestContext';

export interface RecordEventParams<K extends WebhookEventType> {
  readonly merchantId: string;
  readonly type: K;
  /**
   * The resource as the API renders it NOW — `data.object`. Typed by
   * `WebhookEventPayload`, so an event cannot carry the wrong resource.
   */
  readonly object: WebhookEventPayload[K];
  /** The moved fields' values before the change — `data.previous_attributes`. */
  readonly previousAttributes?: Record<string, unknown> | undefined;
  /** The connected account (`ca_…`) it is about — `event.account` (ADR 0012 D7). */
  readonly account?: string | null | undefined;
  /** The INTERNAL id of the payment it is about, when it is about one. */
  readonly paymentIntentId?: string | undefined;
}

/**
 * Store an event and enqueue its deliveries, on the caller's transaction.
 *
 * MUST be called inside the transaction of the change: called after a commit,
 * a crash between the two loses the event with the change already made — the
 * failure the outbox exists to remove.
 *
 * `request` is read from the request context (`lib/requestContext.ts`): the
 * merchant API call this change is part of, or none for a background loop.
 */
export async function recordEvent<K extends WebhookEventType>(
  tx: DatabaseOrTransaction,
  params: RecordEventParams<K>,
): Promise<EventRow> {
  const request = currentEventRequest();
  const event = await insertEvent(tx, {
    publicId: newId('evt'),
    merchantId: params.merchantId,
    type: params.type,
    apiVersion: PEABLE_API_VERSION,
    dataObject: params.object as unknown as Record<string, unknown>,
    previousAttributes: params.previousAttributes,
    account: params.account,
    paymentIntentId: params.paymentIntentId,
    requestId: request.id,
    idempotencyKey: request.idempotency_key,
  });
  if (!(TARGETED_WEBHOOK_EVENT_TYPES as readonly string[]).includes(params.type)) {
    await enqueueEventDeliveries(tx, event);
  }
  return event;
}

/**
 * The synthetic `webhook_endpoint.test` event, sent to ONE endpoint whatever
 * its `enabled_events` say — enabled or not is the caller's to check. Stored,
 * so its delivery has a referent and the merchant can find it in `/v1/events`.
 *
 * @returns the delivery's id.
 */
export async function recordTestEvent(
  tx: DatabaseOrTransaction,
  endpoint: WebhookEndpointRow,
  dto: WebhookEndpoint,
): Promise<{ event: EventRow; deliveryId: string }> {
  const event = await recordEvent(tx, {
    merchantId: endpoint.merchantId,
    type: 'webhook_endpoint.test',
    object: dto,
  });
  const deliveryId = await enqueueDelivery(tx, {
    merchantId: endpoint.merchantId,
    eventId: event.id,
    endpointId: endpoint.id,
    url: endpoint.url,
  });
  return { event, deliveryId };
}
