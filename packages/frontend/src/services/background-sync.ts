/**
 * Background sync task registration.
 *
 * Periodically wakes the wallet (when allowed by the OS) to check for new
 * incoming transactions and fire a local notification.
 *
 * ## Limitations (be honest about these)
 *
 * - On iOS the OS controls when this fires. It is _not_ realtime and may
 *   only run every 1–6 hours (or never, depending on user habits). The
 *   minimum interval hint is 15 minutes.
 * - On Android the minimum interval is 15 minutes and the system may delay
 *   execution to batch work with other apps.
 * - The SPV client lives in-process with wallet-store. A background wake-up
 *   does not necessarily have DNS, peers, or a warm chain tip. Connecting,
 *   syncing headers, and scanning merkle blocks takes tens of seconds and
 *   may exceed the OS-imposed background window.
 * - For _true_ realtime "you got paid" alerts a server-side push
 *   (Electrum-style notification server → APNS/FCM) is required. FAIRWallet
 *   does not run such a server today.
 *
 * ## Current implementation
 *
 * This file registers a task that currently only returns `Success`. The app
 * still gets notifications when it comes to the foreground via the
 * `tx-notifier` subscriber wired up in `app/_layout.tsx`. Wiring a full SPV
 * poll into the background body requires a redesign of `wallet-store` so
 * that the key manager, header store, and SPV client can be hydrated
 * outside of React. That work is tracked separately.
 */

import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';

export const BACKGROUND_TASK_NAME = 'fairwallet-bg-sync';

// Must be defined at module scope so the task is registered with the JS
// runtime before React mounts. The body is intentionally a stub — see the
// JSDoc above for the rationale.
TaskManager.defineTask(BACKGROUND_TASK_NAME, async () => {
  try {
    // Future: hydrate wallet state outside of React, reconnect the SPV
    // client, scan for new received transactions since the last seen
    // block height, and call `scheduleReceivedNotification` for each.
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * Register the background task with the OS. Idempotent — the underlying
 * `registerTaskAsync` is a no-op when a task with the same name is already
 * registered. Safe to call at every app boot.
 */
export async function registerBackgroundSync(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return;
    await BackgroundTask.registerTaskAsync(BACKGROUND_TASK_NAME, {
      // 15 minutes is the hardware-enforced minimum on both iOS and Android.
      // The OS treats this as a hint and may fire the task less frequently.
      minimumInterval: 15,
    });
  } catch {
    // Background tasks are unavailable on some platforms (web / electron)
    // or may fail to register for transient reasons. Failing to register
    // is not fatal — foreground sync still works.
  }
}
