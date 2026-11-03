import type { z } from 'zod';

/** One webhook event type as the OpenAPI `webhooks` section documents it. */
export interface WebhookEventContract {
  /** `payment_intent.succeeded`. */
  readonly type: string;
  readonly description?: string;
  /** The whole envelope (`Event`) with `data.object` narrowed to this type's object. */
  readonly schema: z.ZodType;
}

/**
 * Every event type the gateway emits, with its payload. Filled from the events
 * contracts (`resources/events`).
 */
export function webhookEvents(): readonly WebhookEventContract[] {
  return [];
}
