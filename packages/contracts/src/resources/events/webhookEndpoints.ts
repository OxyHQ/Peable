import { z } from 'zod';
import { deletedOf, listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import {
  expandOnlyQuery,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import { livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  WEBHOOK_ENABLED_EVENTS,
  WEBHOOK_ENDPOINT_DESCRIPTION_MAX,
  WEBHOOK_ENDPOINT_DISABLED_REASONS,
  WEBHOOK_ENDPOINT_STATUSES,
  WEBHOOK_SECRET_ROLL_MAX_EXPIRES_IN_SECONDS,
  type WebhookEnabledEvent,
} from '../../vocabulary/events';
import { webhookDeliverySchema } from './webhookDeliveries';

/**
 * Webhook endpoints (`we_…`, ADR 0014 D4) — one URL a merchant receives events
 * at, with the event types it wants and the secret deliveries to it are signed
 * with. A merchant may hold several; every event fans out to each ENABLED
 * endpoint whose `enabled_events` matches it, as one delivery per endpoint.
 */

const enabledEvent = z.enum(WEBHOOK_ENABLED_EVENTS);

const endpointShape = {
  id: z.string(),
  object: z.literal('webhook_endpoint'),
  livemode: livemode.describe('The mode of the merchant that owns it (ADR 0017).'),
  url: z.string(),
  description: z.string().nullable(),
  enabled_events: z
    .array(enabledEvent)
    .describe('The event types sent to it; `*` is every type, including ones added later.'),
  status: z.enum(WEBHOOK_ENDPOINT_STATUSES),
  disabled_reason: z
    .enum(WEBHOOK_ENDPOINT_DISABLED_REASONS)
    .nullable()
    .describe(
      '`null` exactly when `status` is `enabled`. `delivery_failures`: every delivery failed for three days straight.',
    ),
  api_version: z.string().describe('The wire version events are rendered with for this endpoint.'),
  metadata,
  created: unixSeconds,
  updated_at: unixSeconds,
};

const endpointExample = {
  id: 'we_0193b8f2c1a87d3e9f4c',
  object: 'webhook_endpoint',
  livemode: false,
  url: 'https://example.com/peable/webhooks',
  description: 'Order fulfilment',
  enabled_events: ['payment_intent.succeeded', 'charge.refunded'],
  status: 'enabled',
  disabled_reason: null,
  api_version: '2026-11-03',
  metadata: {},
  created: 1793750000,
  updated_at: 1793750000,
} as const;

/** An endpoint as every answer but a create and a roll renders it: never the secret. */
export const webhookEndpointSchema = defineObject(
  'webhook_endpoint',
  'WebhookEndpoint',
  z.object(endpointShape).strict(),
  { examples: [endpointExample] },
);
export type WebhookEndpoint = Expand<z.output<typeof webhookEndpointSchema>>;

/**
 * The answer of a create and of a `roll_secret` — the ONLY two that show the
 * signing secret. Peable never shows it again; a lost secret is rolled, not
 * retrieved.
 */
export const webhookEndpointWithSecretSchema = defineComponent(
  'WebhookEndpointWithSecret',
  z
    .object({
      ...endpointShape,
      secret: z
        .string()
        .regex(/^whsec_/)
        .describe('The signing secret (`whsec_…`), shown on this answer only.'),
    })
    .strict(),
  { examples: [{ ...endpointExample, secret: 'whsec_9f4a7d3e0193b8f2c1a87d3e9f4a7d3e' }] },
);
export type WebhookEndpointWithSecret = Expand<z.output<typeof webhookEndpointWithSecretSchema>>;

/** What `DELETE /v1/webhook_endpoints/:id` answers. */
export const deletedWebhookEndpointSchema = defineComponent(
  'DeletedWebhookEndpoint',
  deletedOf('webhook_endpoint'),
);
export type DeletedWebhookEndpoint = z.output<typeof deletedWebhookEndpointSchema>;

declare module '../../common/objects' {
  interface ObjectMap {
    webhook_endpoint: WebhookEndpoint;
  }
}

const enabledEventsParam = z
  .array(enabledEvent)
  .min(1, 'enabled_events needs at least one event type, or "*"')
  .max(WEBHOOK_ENABLED_EVENTS.length)
  // A repeated type means nothing more than one; stored once.
  .transform((list): WebhookEnabledEvent[] => [...new Set(list)]);

const descriptionParam = z.string().max(WEBHOOK_ENDPOINT_DESCRIPTION_MAX);

const urlParam = z
  .string()
  .min(1)
  .describe('An `https` URL (a test-mode endpoint may also use `http`), ports 80/443 only.');

export const createWebhookEndpointParams = z
  .object({
    url: urlParam,
    enabled_events: enabledEventsParam,
    description: descriptionParam.min(1).optional(),
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreateWebhookEndpointParams = z.input<typeof createWebhookEndpointParams>;

export const updateWebhookEndpointParams = z
  .object({
    url: urlParam.optional(),
    enabled_events: enabledEventsParam.optional(),
    disabled: z
      .boolean()
      .optional()
      .describe('`true` stops deliveries; `false` re-enables an endpoint, whatever disabled it.'),
    description: descriptionParam.optional().describe('`""` clears it.'),
    metadata: metadataUpdateParam.optional(),
  })
  .strict();
export type UpdateWebhookEndpointParams = z.input<typeof updateWebhookEndpointParams>;

export const rollWebhookEndpointSecretParams = z
  .object({
    expires_in_seconds: z
      .number()
      .int()
      .min(0)
      .max(WEBHOOK_SECRET_ROLL_MAX_EXPIRES_IN_SECONDS)
      .optional()
      .describe(
        'How long the PREVIOUS secret keeps signing beside the new one, in seconds (0–86400, default 0). While both are live every delivery carries two `v1=` signatures, so a receiver can switch secrets without a gap.',
      ),
  })
  .strict();
export type RollWebhookEndpointSecretParams = z.input<typeof rollWebhookEndpointSecretParams>;

export const listWebhookEndpointsQuery = listQuery({});
export type ListWebhookEndpointsParams = z.input<typeof listWebhookEndpointsQuery>;

const idDoc = { id: 'The webhook endpoint (`we_…`).' } as const;

export const webhookEndpointRoutes = [
  defineRoute({
    operationId: 'createWebhookEndpoint',
    method: 'post',
    path: '/v1/webhook_endpoints',
    tag: 'Webhook endpoints',
    summary: 'Create a webhook endpoint',
    description:
      'The answer is the ONLY one that shows `secret`. A retry with the same `Idempotency-Key` replays it, secret included, for 24 hours. At most 16 endpoints per merchant and mode.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createWebhookEndpointParams,
    response: webhookEndpointWithSecretSchema,
    sdk: 'webhookEndpoints.create',
  }),
  defineRoute({
    operationId: 'listWebhookEndpoints',
    method: 'get',
    path: '/v1/webhook_endpoints',
    tag: 'Webhook endpoints',
    summary: 'List webhook endpoints',
    description: 'Newest first. Never the secret.',
    auth: 'service',
    scope: 'payments:read',
    query: listWebhookEndpointsQuery,
    response: listOf(webhookEndpointSchema),
    sdk: 'webhookEndpoints.list',
    expandable: 'webhook_endpoint',
  }),
  defineRoute({
    operationId: 'retrieveWebhookEndpoint',
    method: 'get',
    path: '/v1/webhook_endpoints/{id}',
    tag: 'Webhook endpoints',
    summary: 'Retrieve a webhook endpoint',
    description: 'Never the secret: a lost secret is rolled, not retrieved.',
    auth: 'service',
    scope: 'payments:read',
    params: idDoc,
    query: expandOnlyQuery,
    response: webhookEndpointSchema,
    sdk: 'webhookEndpoints.retrieve',
    expandable: 'webhook_endpoint',
  }),
  defineRoute({
    operationId: 'updateWebhookEndpoint',
    method: 'post',
    path: '/v1/webhook_endpoints/{id}',
    tag: 'Webhook endpoints',
    summary: 'Update a webhook endpoint',
    description:
      '`url`, `enabled_events`, `disabled`, `description` (`""` clears it) and `metadata` (a patch).',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: idDoc,
    body: updateWebhookEndpointParams,
    response: webhookEndpointSchema,
    sdk: 'webhookEndpoints.update',
  }),
  defineRoute({
    operationId: 'deleteWebhookEndpoint',
    method: 'delete',
    path: '/v1/webhook_endpoints/{id}',
    tag: 'Webhook endpoints',
    summary: 'Delete a webhook endpoint',
    description: 'Its deliveries go with it, pending ones included.',
    auth: 'service',
    scope: 'payments:write',
    params: idDoc,
    response: deletedWebhookEndpointSchema,
    sdk: 'webhookEndpoints.del',
  }),
  defineRoute({
    operationId: 'rollWebhookEndpointSecret',
    method: 'post',
    path: '/v1/webhook_endpoints/{id}/roll_secret',
    tag: 'Webhook endpoints',
    summary: 'Roll the signing secret',
    description:
      'Mint a new secret and show it once. With `expires_in_seconds` (≤ 24h) the previous one keeps signing beside it until then; without, it stops now.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: idDoc,
    body: rollWebhookEndpointSecretParams,
    response: webhookEndpointWithSecretSchema,
    sdk: 'webhookEndpoints.rollSecret',
  }),
  defineRoute({
    operationId: 'sendWebhookEndpointTestEvent',
    method: 'post',
    path: '/v1/webhook_endpoints/{id}/test',
    tag: 'Webhook endpoints',
    summary: 'Send a test event',
    description:
      'Send this endpoint a `webhook_endpoint.test` event now and answer the delivery after its first attempt. A disabled endpoint is refused (`webhook_endpoint_disabled`).',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: idDoc,
    response: webhookDeliverySchema,
    sdk: 'webhookEndpoints.sendTestEvent',
  }),
] as const;
