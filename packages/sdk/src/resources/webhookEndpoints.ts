import type {
  CreateWebhookEndpointParams,
  DeletedWebhookEndpoint,
  ExpandParams,
  List,
  ListParams,
  RollWebhookEndpointSecretParams,
  UpdateWebhookEndpointParams,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  WebhookEvent,
  WebhookEventType,
} from '@peable.to/shared-types';
import type { GatewayClient, RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';
import { liveStream, type LiveStreamOptions } from '../core/liveStream';

/**
 * Webhook endpoints, events and deliveries (ADR 0014 D4).
 *
 * An EVENT is stored once, in the same transaction as the change it records,
 * and kept 30 days. Each enabled endpoint whose `enabled_events` match it gets
 * one DELIVERY of it, retried for about three days. Verify what arrives with
 * `peable.webhooks.constructEvent`.
 */

function path(id: string): string {
  return `/v1/webhook_endpoints/${encodeURIComponent(id)}`;
}

export class WebhookEndpointsResource {
  constructor(private readonly client: RestClient) {}

  /**
   * Register an endpoint. The response carries `secret` (`whsec_…`) — the
   * ONLY time Peable shows it. Store it; a lost secret is rolled, not read.
   */
  create(
    params: CreateWebhookEndpointParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<WebhookEndpointWithSecret> {
    return this.client.request<WebhookEndpointWithSecret>('POST', '/v1/webhook_endpoints', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<WebhookEndpoint> {
    return this.client.request<WebhookEndpoint>('GET', path(id), {
      query: { expand: params.expand },
    });
  }

  /** `disabled: true` stops deliveries; `disabled: false` re-enables, whatever disabled it. */
  update(id: string, params: UpdateWebhookEndpointParams): Promise<WebhookEndpoint> {
    return this.client.request<WebhookEndpoint>('POST', path(id), { body: params });
  }

  list(params: ListParams = {}): ApiListPromise<WebhookEndpoint> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<List<WebhookEndpoint>>('GET', '/v1/webhook_endpoints', {
          query: listQuery(page),
        }),
      params,
    );
  }

  /** Delete an endpoint. Its pending deliveries are dropped with it. */
  del(id: string): Promise<DeletedWebhookEndpoint> {
    return this.client.request<DeletedWebhookEndpoint>('DELETE', path(id));
  }

  /**
   * Replace the signing secret; the response carries the new one, once.
   *
   * With `expires_in_seconds` (at most 86 400) the previous secret keeps
   * signing beside it until then — every delivery carries a `v1=` for each —
   * so you can deploy the new secret without refusing a single event.
   */
  rollSecret(
    id: string,
    params: RollWebhookEndpointSecretParams = {},
  ): Promise<WebhookEndpointWithSecret> {
    return this.client.request<WebhookEndpointWithSecret>('POST', `${path(id)}/roll_secret`, {
      body: params,
    });
  }

  /**
   * Send this endpoint a `webhook_endpoint.test` event — Orbit's "send test
   * event". Answers the delivery after its first attempt. The endpoint must be
   * enabled.
   */
  sendTestEvent(id: string): Promise<WebhookDelivery> {
    return this.client.request<WebhookDelivery>('POST', `${path(id)}/test`);
  }
}

export interface EventListParams extends ListParams {
  /** An exact type, or a prefix ending in `.*` (`'payment_intent.*'`). */
  type?: WebhookEventType | `${string}.*`;
  /**
   * `true`: only events every delivery of which succeeded. `false`: only events
   * with a delivery still pending or failed.
   */
  delivery_success?: boolean;
  /** Only the events about this payment (`pi_…`). */
  payment_intent?: string;
}

export interface EventStreamParams extends LiveStreamOptions {
  /**
   * Only these: exact types or `prefix.*` patterns
   * (`['payment_intent.succeeded', 'charge.*']`). Absent: every event.
   */
  types?: readonly (WebhookEventType | `${string}.*`)[];
}

/** Every event of the last 30 days, exactly as its deliveries carried it. */
export class EventsResource {
  constructor(private readonly client: GatewayClient) {}

  /**
   * Every event of this merchant, as it is recorded — rendered exactly as a
   * webhook delivery carries it. TEST MODE ONLY (a live credential is refused
   * with `PeablePermissionError`, code `test_mode_only`): this is what
   * `peable listen` forwards to a local server.
   *
   * Reconnects on its own and resumes after the last event it yielded; ends
   * when `signal` aborts.
   *
   *   for await (const event of peable.events.stream({ types: ['payment_intent.*'] })) { … }
   */
  stream(params: EventStreamParams = {}): AsyncGenerator<WebhookEvent> {
    const { types, ...options } = params;
    return liveStream<WebhookEvent>(
      this.client,
      '/v1/events/stream',
      'event',
      { types: types && types.length > 0 ? types.join(',') : undefined },
      options,
    );
  }

  retrieve(id: string): Promise<WebhookEvent> {
    return this.client.request<WebhookEvent>('GET', `/v1/events/${encodeURIComponent(id)}`);
  }

  list(params: EventListParams = {}): ApiListPromise<WebhookEvent> {
    return listPromise(
      (page: EventListParams) =>
        this.client.request<List<WebhookEvent>>('GET', '/v1/events', {
          query: listQuery(page, {
            type: page.type,
            delivery_success:
              page.delivery_success === undefined ? undefined : String(page.delivery_success),
            payment_intent: page.payment_intent,
          }),
        }),
      params,
    );
  }
}

export interface WebhookDeliveryListParams extends ListParams {
  /** Only the deliveries of this event (`evt_…`). */
  event?: string;
  /** Only the deliveries to this endpoint (`we_…`). */
  webhook_endpoint?: string;
}

/** The delivery log: one row per event per endpoint, with its attempts. */
export class WebhookDeliveriesResource {
  constructor(private readonly client: RestClient) {}

  list(params: WebhookDeliveryListParams = {}): ApiListPromise<WebhookDelivery> {
    return listPromise(
      (page: WebhookDeliveryListParams) =>
        this.client.request<List<WebhookDelivery>>('GET', '/v1/webhook_deliveries', {
          query: listQuery(page, { event: page.event, webhook_endpoint: page.webhook_endpoint }),
        }),
      params,
    );
  }

  /**
   * Send the delivery's event to its endpoint again — the same stored event, as
   * a NEW delivery, attempted at once. Refused while the endpoint is disabled.
   */
  redeliver(id: string): Promise<WebhookDelivery> {
    return this.client.request<WebhookDelivery>(
      'POST',
      `/v1/webhook_deliveries/${encodeURIComponent(id)}/redeliver`,
    );
  }
}
