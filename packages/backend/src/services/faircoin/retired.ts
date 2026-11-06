import type { PaymentIntentCancellationReason } from '@peable.to/shared-types';

/**
 * Whether a cancelled FairCoin payment was RETIRED rather than ended — its
 * address was withdrawn before anything was broadcast, because the recipient's
 * key was replaced (`recipient_key_changed`) or the deployment closed its
 * network (`faircoin_network_closed`), both ADR 0002 (amended 2026-11-06). The
 * order wrapping it forgets it and stays open for a fresh reservation, as for a
 * lapsed quote; a retried confirm is never answered with it.
 */
export function isRetiredReservation(reason: PaymentIntentCancellationReason | null): boolean {
  return reason === 'recipient_key_changed' || reason === 'faircoin_network_closed';
}
