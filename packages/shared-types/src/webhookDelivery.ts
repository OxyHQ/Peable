// Webhook deliveries (ADR 0014 D4, ADR 0001 D7) — one event sent to one
// endpoint. The wire types are the contract's (`@peable.to/contracts`
// `webhookDeliverySchema`), re-exported here as types.
export {
  WEBHOOK_DELIVERY_STATUSES,
  type WebhookDeliveryStatus,
} from '@peable.to/contracts/vocabulary';
export type { ListWebhookDeliveriesParams, WebhookDelivery } from '@peable.to/contracts';
