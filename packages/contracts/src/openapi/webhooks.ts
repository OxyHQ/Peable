import type { z } from 'zod';
import { eventSchemaOf, WEBHOOK_EVENT_DESCRIPTIONS } from '../resources/events/events';
import { WEBHOOK_EVENT_TYPES } from '../vocabulary/events';

/** One webhook event type as the OpenAPI `webhooks` section documents it. */
export interface WebhookEventContract {
  /** `payment_intent.succeeded`. */
  readonly type: string;
  readonly description?: string;
  /** The whole envelope (`Event`) with `data.object` narrowed to this type's object. */
  readonly schema: z.ZodType;
}

/**
 * Every event type the gateway emits, with its payload: one entry per member
 * of `WEBHOOK_EVENT_TYPES`, its body the `Event` envelope with `type` fixed and
 * `data.object` the object `WEBHOOK_EVENT_OBJECTS` names.
 */
export function webhookEvents(): readonly WebhookEventContract[] {
  return WEBHOOK_EVENT_TYPES.map((type) => ({
    type,
    description: WEBHOOK_EVENT_DESCRIPTIONS[type],
    schema: eventSchemaOf(type),
  }));
}
