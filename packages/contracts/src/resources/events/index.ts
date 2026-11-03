import { eventRoutes } from './events';
import { webhookDeliveryRoutes } from './webhookDeliveries';
import { webhookEndpointRoutes } from './webhookEndpoints';

export * from './events';
export * from './webhookDeliveries';
export * from './webhookEndpoints';

/** Events, the webhook endpoints they are sent to, and the deliveries of them. */
export const eventsRoutes = [
  ...eventRoutes,
  ...webhookEndpointRoutes,
  ...webhookDeliveryRoutes,
] as const;
