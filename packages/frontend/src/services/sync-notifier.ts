/**
 * Sync notifier — watches the wallet store and mirrors sync progress into an
 * ongoing local notification ("Syncing 42% · block 13,690"), then dismisses it
 * when the wallet finishes syncing.
 *
 * Runs at the React tree level (wired up in `_layout.tsx`) so `wallet-store`
 * stays pure and free of notification imports — the same split used by
 * {@link ./tx-notifier}.
 *
 * Scope: this reflects the sync that runs while the app is alive. Keeping the
 * SPV sync itself running after the app is backgrounded/closed needs a native
 * foreground service (see `background-sync.ts`) and is out of scope here; the
 * OS removes this ongoing notification automatically when the process ends.
 */

import { useWalletStore } from '../wallet/wallet-store';
import { presentSyncNotification, dismissSyncNotification } from './notifications';

let unsubscribe: (() => void) | null = null;
/** Last percent pushed to the notification; -1 means "no notification shown". */
let shownProgress = -1;
/** Last block height pushed to the notification. */
let shownHeight = -1;
/** Wall-clock ms of the last notification update, to throttle height-only ticks. */
let lastUpdateAt = 0;
/**
 * Minimum gap between height-only notification updates. A fast header sync can
 * advance the tip hundreds of blocks per second while the rounded percent sits
 * still; without a throttle we'd re-post the tray notification that often.
 */
const HEIGHT_UPDATE_THROTTLE_MS = 750;

/**
 * Start mirroring sync progress into the ongoing notification. Idempotent — a
 * second call is a no-op so the store isn't subscribed twice.
 */
export function startSyncNotifier(): void {
  if (unsubscribe) return;

  unsubscribe = useWalletStore.subscribe((state, prevState) => {
    if (
      state.isSyncing === prevState.isSyncing &&
      state.syncProgress === prevState.syncProgress &&
      state.chainHeight === prevState.chainHeight
    ) {
      return;
    }

    if (state.isSyncing) {
      const percentChanged = state.syncProgress !== shownProgress;
      const heightChanged = state.chainHeight !== shownHeight;
      const now = Date.now();
      // Refresh immediately on a percent change; also refresh on height ticks so
      // the notification keeps moving while the rounded percent is unchanged —
      // throttled so a fast header sync doesn't re-post the tray every block.
      if (percentChanged || (heightChanged && now - lastUpdateAt >= HEIGHT_UPDATE_THROTTLE_MS)) {
        shownProgress = state.syncProgress;
        shownHeight = state.chainHeight;
        lastUpdateAt = now;
        void presentSyncNotification(state.syncProgress, state.chainHeight);
      }
    } else if (shownProgress !== -1) {
      // Sync finished (or the wallet was locked/reset) — clear the notification.
      shownProgress = -1;
      shownHeight = -1;
      void dismissSyncNotification();
    }
  });
}

/**
 * Stop the subscriber and clear any lingering notification. Used in tests /
 * teardown; the normal app lifecycle keeps it running for the whole process.
 */
export function stopSyncNotifier(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  shownProgress = -1;
  shownHeight = -1;
  lastUpdateAt = 0;
  void dismissSyncNotification();
}
