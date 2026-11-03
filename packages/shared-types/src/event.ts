// Events (`evt_…`, ADR 0014 D4) — Stripe's event names (ADR 0019) with the
// resource nested under `data.object`. The wire types are the contract's
// (`@peable.to/contracts` `eventSchema`, `WebhookEventPayload`), re-exported here
// as types; the closed list of event types and the object each carries is the
// contract's zod-free vocabulary.
export {
  PEABLE_API_VERSION,
  TARGETED_WEBHOOK_EVENT_TYPES,
  type TargetedWebhookEventType,
  WEBHOOK_EVENT_OBJECTS,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventObjectType,
  type WebhookEventType,
} from '@peable.to/contracts/vocabulary';
export type {
  BillingObservation,
  ListEventsParams,
  RetrieveEventParams,
  StreamEventsParams,
  WebhookEvent,
  WebhookEventPayload,
  WebhookEventRequest,
} from '@peable.to/contracts';
