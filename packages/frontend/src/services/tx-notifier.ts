/**
 * Transaction notifier — watches the wallet store and fires a sound plus a
 * local notification whenever a new incoming transaction is detected.
 *
 * The subscriber runs at the React tree level (wired up in `_layout.tsx`)
 * so that `wallet-store` itself stays pure and doesn't pull in audio /
 * notification modules.
 *
 * ## Detection rules
 *
 * - A "seen" set of txids is maintained for the lifetime of the subscriber.
 *   Any txid already in the set is ignored.
 * - On the first state change where `state.initialized` flips from false to
 *   true (database/SPV hydration), every current tx is absorbed into the
 *   seen set without firing — this prevents spamming notifications when
 *   the wallet restores its history from disk at app boot or after a
 *   wallet switch.
 * - After hydration any new txid with a positive amount (received, not
 *   sent) triggers `playReceived()` plus a local notification.
 * - The filter works on `txid` identity rather than list length, which is
 *   robust against list reordering or in-place confirmation updates.
 */

import { useWalletStore, type WalletTransaction } from '../wallet/wallet-store';
import { playReceived } from './sounds';
import { scheduleReceivedNotification } from './notifications';

let unsubscribe: (() => void) | null = null;
const seenTxids = new Set<string>();

function isIncoming(tx: WalletTransaction): boolean {
  return tx.amount > 0n;
}

function absorb(transactions: readonly WalletTransaction[]): void {
  for (const tx of transactions) {
    seenTxids.add(tx.txid);
  }
}

/**
 * Start watching the wallet store for new received transactions. Idempotent
 * — calling this a second time is a no-op so we don't double-fire.
 */
export function startTxNotifier(): void {
  if (unsubscribe) return;

  // Absorb whatever is already in the store at subscribe time (usually an
  // empty list at module load, but defensively handled for hot reloads and
  // wallet switches that happen before this function is called).
  absorb(useWalletStore.getState().transactions);

  unsubscribe = useWalletStore.subscribe((state, prevState) => {
    // Switching wallets (or locking, which clears activeWalletId/transactions)
    // changes whose txids belong in `seenTxids`. Drop the old set so we don't
    // accumulate ids across wallets forever (N-15) and so a tx that legitimately
    // arrived in the new wallet can fire even if it shares a txid with one we
    // already absorbed from the previous wallet. We re-absorb below when
    // `initialized` flips back to true for the new wallet.
    if (state.activeWalletId !== prevState.activeWalletId) {
      seenTxids.clear();
    }

    // Wallet just finished hydrating from disk / SPV — absorb every tx
    // currently in the store without firing so the restore doesn't look
    // like a burst of incoming payments.
    if (state.initialized && !prevState.initialized) {
      absorb(state.transactions);
      return;
    }

    if (state.transactions === prevState.transactions) return;

    for (const tx of state.transactions) {
      if (seenTxids.has(tx.txid)) continue;
      seenTxids.add(tx.txid);
      if (isIncoming(tx)) {
        playReceived();
        void scheduleReceivedNotification(tx.amount, tx.txid);
      }
    }
  });
}

/**
 * Stop watching the wallet store. Used in tests / teardown paths. In the
 * normal app lifecycle the subscriber lives for the duration of the
 * process.
 */
export function stopTxNotifier(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  seenTxids.clear();
}
