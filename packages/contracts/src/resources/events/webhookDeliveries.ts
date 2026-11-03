import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import { idParam, listQuery } from '../../common/params';
import { livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENT_TYPES } from '../../vocabulary/events';

/**
 * Webhook deliveries (ADR 0014 D4) — one event sent to one webhook endpoint.
 * An event that matches three endpoints is three deliveries, each with its own
 * attempts, retried for about three days (ADR 0001 D7).
 */
export const webhookDeliverySchema = defineObject(
  'webhook_delivery',
  'WebhookDelivery',
  z
    .object({
      id: z.string(),
      object: z.literal('webhook_delivery'),
      livemode: livemode.describe('The mode of the merchant it was sent for (ADR 0017).'),
      event_id: z.string().describe('The `evt_…` delivered — `GET /v1/events/:id` returns it.'),
      event_type: z.enum(WEBHOOK_EVENT_TYPES),
      webhook_endpoint_id: z.string().describe('The `we_…` it was sent to.'),
      url: z.string().describe('The URL actually POSTed to, as of the latest attempt.'),
      attempts: z.number().int().nonnegative(),
      delivered: z.boolean(),
      last_status: z
        .enum(WEBHOOK_DELIVERY_STATUSES)
        .describe(
          '`pending`: will be attempted (`next_attempt_at`). `delivered`: terminal success. `failed`: the endpoint refused it (a 4xx, a blocked address) or was disabled first — never retried. `dead`: every attempt failed transiently for three days; it can be redelivered.',
        ),
      last_error: z
        .string()
        .optional()
        .describe('Why the last attempt did not succeed — operator-facing, never a secret.'),
      next_attempt_at: unixSeconds
        .optional()
        .describe('When the next attempt is due. Absent once the delivery is terminal.'),
      created: unixSeconds,
      updated_at: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: '0193b8f2-c1a8-7d3e-9f4a-7d3e0193b8f2',
        object: 'webhook_delivery',
        livemode: false,
        event_id: 'evt_0193b8f2c1a87d3e9f4b',
        event_type: 'payment_intent.succeeded',
        webhook_endpoint_id: 'we_0193b8f2c1a87d3e9f4c',
        url: 'https://example.com/peable/webhooks',
        attempts: 1,
        delivered: true,
        last_status: 'delivered',
        created: 1793750400,
        updated_at: 1793750401,
      },
    ],
  },
);
export type WebhookDelivery = Expand<z.output<typeof webhookDeliverySchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    webhook_delivery: WebhookDelivery;
  }
}

/** The filters `GET /v1/webhook_deliveries` adds to the list parameters. */
export const listWebhookDeliveriesFilters = {
  event: idParam.optional().describe('Only the deliveries of this event (`evt_…`).'),
  webhook_endpoint: idParam.optional().describe('Only the deliveries to this endpoint (`we_…`).'),
};

export const listWebhookDeliveriesQuery = listQuery(listWebhookDeliveriesFilters);
export type ListWebhookDeliveriesParams = z.input<typeof listWebhookDeliveriesQuery>;

export const webhookDeliveryRoutes = [
  defineRoute({
    operationId: 'listWebhookDeliveries',
    method: 'get',
    path: '/v1/webhook_deliveries',
    tag: 'Webhook deliveries',
    summary: 'List webhook deliveries',
    description:
      "The delivery log, newest first: one event's deliveries, or one endpoint's. Both filters are public ids resolved inside your scope.",
    auth: 'service',
    scope: 'payments:read',
    query: listWebhookDeliveriesQuery,
    response: listOf(webhookDeliverySchema),
    sdk: 'webhookDeliveries.list',
    expandable: 'webhook_delivery',
  }),
  defineRoute({
    operationId: 'redeliverWebhookDelivery',
    method: 'post',
    path: '/v1/webhook_deliveries/{id}/redeliver',
    tag: 'Webhook deliveries',
    summary: 'Redeliver a webhook delivery',
    description:
      "Send the delivery's event to its endpoint again — the SAME stored event, as a NEW delivery, attempted at once; answers that new delivery. Refused while the endpoint is disabled (`webhook_endpoint_disabled`).",
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The webhook delivery.' },
    response: webhookDeliverySchema,
    sdk: 'webhookDeliveries.redeliver',
  }),
] as const;
