import type { WebhookEventType } from './event';

/**
 * Where one webhook delivery stands (ADR 0001 D7).
 *
 * Was `'delivered' | 'failed'` — the two outcomes an inline, best-effort
 * delivery could report once it had already given up. Delivery is now a durable
 * outbox, so a delivery exists BEFORE any attempt and this set has to say so.
 *
 *  - `pending`   — enqueued and will be attempted. `nextAttemptAt` says when.
 *  - `delivered` — terminal success.
 *  - `failed`    — the endpoint REFUSED it (a 4xx, a blocked address). No retry
 *                  can fix that, so none is made.
 *  - `dead`      — every attempt failed transiently and the budget ran out. The
 *                  envelope is kept and can be redelivered by hand.
 *
 * ⚠️ Widening a published union is a breaking change for a consumer that
 * switches exhaustively on it. It is the honest shape: the previous one could
 * not describe a delivery that had not been attempted yet, which is now the
 * state every delivery starts in.
 */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export interface WebhookDelivery {
  id: string;
  object: 'webhook_delivery';
  merchantId: string;
  /**
   * The `pi_…` this delivery is about — `null` when the event is not about a
   * payment.
   *
   * Nullable since `connected_account.updated`, which is about a SELLER. The
   * alternative was to name an unrelated payment to keep the field a string,
   * which is worse than a null: a consumer correlating on it would attach a
   * seller's readiness change to a payment that has nothing to do with it.
   */
  intentId: string | null;
  eventId: string;
  eventType: WebhookEventType;
  url: string;
  attempts: number;
  delivered: boolean;
  lastStatus: WebhookDeliveryStatus;
  /**
   * Why the last attempt did not succeed — operator-facing, never a secret.
   * Absent while pending with no attempts, and after a success.
   */
  lastError?: string;
  /** When the next attempt is due, ISO-8601. Absent once the delivery is terminal. */
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}
