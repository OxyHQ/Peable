// Webhook endpoints (`we_…`, ADR 0014 D4). The wire types are the contract's
// (`@peable.to/contracts` `webhookEndpointSchema`), re-exported here as types;
// the value sets and bounds are the contract's zod-free vocabulary.
export {
  WEBHOOK_ENABLED_EVENTS,
  WEBHOOK_ENDPOINT_DESCRIPTION_MAX,
  WEBHOOK_ENDPOINT_DISABLED_REASONS,
  WEBHOOK_ENDPOINT_STATUSES,
  WEBHOOK_ENDPOINTS_MAX_PER_MERCHANT,
  WEBHOOK_SECRET_ROLL_MAX_EXPIRES_IN_SECONDS,
  type WebhookEnabledEvent,
  type WebhookEndpointDisabledReason,
  type WebhookEndpointStatus,
} from '@peable.to/contracts/vocabulary';
export type {
  CreateWebhookEndpointParams,
  DeletedWebhookEndpoint,
  ListWebhookEndpointsParams,
  RollWebhookEndpointSecretParams,
  UpdateWebhookEndpointParams,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
} from '@peable.to/contracts';
