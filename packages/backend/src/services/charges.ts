/**
 * The `ch_…` snapshot (ADR 0019): what the provider says about the charge a card
 * intent produced — its outcome and card — read AFTER the transition commits,
 * best-effort, and refreshed by the provider's `charge.*` events.
 *
 * The charge ROW is not written here: `transitionIntent` writes it in the same
 * transaction as the status. This fills two nullable columns on it, and a
 * failure leaves them null ("not read yet"), never a guess.
 */
import { getDb } from '../db/postgres';
import { updateChargeSnapshot } from '../db/payments/chargeRepository';
import { linkProviderCharge, type PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import { isChargeReadingProvider } from './providers/provider';
import { selectStoredProvider } from './providers/environmentGuard';
import { judgeAuthorization } from './radar/gates';

export async function syncChargeSnapshot(
  intent: PaymentIntentRow,
  chargeObjectId: string,
): Promise<void> {
  if (intent.rail !== 'card' || !intent.provider) return;
  const db = getDb();
  // The binding first: a transfer's source names this charge, and recording it
  // once here saves every settlement a provider read.
  await linkProviderCharge(db, intent.id, intent.provider, chargeObjectId);
  if (intent.status !== 'requires_capture' && intent.status !== 'succeeded') return;
  const provider = selectStoredProvider(intent.provider, intent.livemode);
  if (!provider || !isChargeReadingProvider(provider)) return;
  try {
    const snapshot = await provider.getChargeSnapshot(chargeObjectId);
    await updateChargeSnapshot(db, intent.id, snapshot);
  } catch {
    // Best-effort: the next `charge.*` event or reconciliation reads it again.
    return;
  }
  // The snapshot is what the post-authorization rules judge (ADR 0022 D3):
  // the first read of it claims the judgment. Never throws.
  await judgeAuthorization(intent.id);
}

/**
 * The same, when only the PAYMENT is known (a provider event about the payment
 * names no charge): read the payment for its latest charge first.
 */
export async function syncChargeFromProvider(intent: PaymentIntentRow): Promise<void> {
  if (intent.rail !== 'card' || !intent.provider || !intent.providerObjectId) return;
  const provider = selectStoredProvider(intent.provider, intent.livemode);
  if (!provider) return;
  try {
    const current = await provider.getStatus(intent.providerObjectId);
    if (current.chargeObjectId !== undefined) {
      await syncChargeSnapshot(intent, current.chargeObjectId);
    }
  } catch {
    // Best-effort, like the snapshot itself.
  }
}
