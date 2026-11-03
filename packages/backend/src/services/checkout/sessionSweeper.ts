/**
 * Checkout Session expiry (Orbit Phase 3): an open session past its
 * `expires_at` becomes `expired` — and `checkout.session.expired` is recorded
 * — in ONE transaction per batch (`expireDueSessions` claims with
 * `for update skip locked`, so two tasks never expire one row twice).
 *
 * Only sessions whose payment cannot still arrive are claimed here: none was
 * created, or it was cancelled. A session whose payment is OPEN expires with
 * that payment — its deadline is the session's, and the intent sweeper's
 * cancellation moves the session in the same transition (`completion.ts`) —
 * and a session whose payment is in flight is never expired under it.
 */
import { expireDueSessions } from '../../db/payments/checkoutSessionRepository';
import { getDb } from '../../db/postgres';
import { toCheckoutSessionDTO } from '../../lib/serializeCheckout';
import { recordEvent } from '../events';
import { kickWebhookOutbox } from '../webhookOutbox';

const DEFAULT_INTERVAL_MS = 60_000;
const BATCH = 100;

/** One pass. Returns how many sessions expired. */
export async function runSessionExpirySweep(): Promise<number> {
  let total = 0;
  for (;;) {
    const expired = await getDb().transaction(async (tx) => {
      const rows = await expireDueSessions(tx, BATCH);
      for (const row of rows) {
        await recordEvent(tx, {
          merchantId: row.merchantId,
          type: 'checkout.session.expired',
          object: toCheckoutSessionDTO(row),
          previousAttributes: { status: 'open' },
          account: row.connectedAccountPublicId,
        });
      }
      return rows.length;
    });
    total += expired;
    if (expired < BATCH) break;
  }
  if (total > 0) kickWebhookOutbox();
  return total;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSessionExpirySweeper(options: { intervalMs?: number } = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runSessionExpirySweep().catch((error: unknown) => {
      process.emitWarning(
        `Peable checkout session sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
}

export function stopSessionExpirySweeper(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
