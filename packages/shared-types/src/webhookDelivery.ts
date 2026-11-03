import type { WebhookEventType } from './event';

/**
 * Where one webhook delivery stands (ADR 0001 D7).
 *
 *  - `pending`   — will be attempted. `next_attempt_at` says when.
 *  - `delivered` — terminal success.
 *  - `failed`    — the endpoint REFUSED it (a 4xx, a blocked address), or the
 *                  endpoint was disabled before it could be attempted. No retry
 *                  can fix that, so none is made.
 *  - `dead`      — every attempt failed transiently over three days and the
 *                  budget ran out. It can be redelivered by hand.
 */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

/**
 * One event sent to one webhook endpoint (ADR 0014 D4). An event that matches
 * three endpoints is three deliveries, each with its own attempts.
 */
export interface WebhookDelivery {
  id: string;
  object: 'webhook_delivery';
  /** The mode of the merchant it was sent for (ADR 0017). */
  livemode: boolean;
  /** The `evt_…` delivered — `GET /v1/events/:id` returns it. */
  event_id: string;
  event_type: WebhookEventType;
  /** The `we_…` it was sent to. */
  webhook_endpoint_id: string;
  /** The URL actually POSTed to, as of the latest attempt. */
  url: string;
  attempts: number;
  delivered: boolean;
  last_status: WebhookDeliveryStatus;
  /** Why the last attempt did not succeed — operator-facing, never a secret. */
  last_error?: string;
  /** When the next attempt is due, Unix seconds. Absent once the delivery is terminal. */
  next_attempt_at?: number;
  created: number;
  updated_at: number;
}
