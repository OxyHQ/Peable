/**
 * Legacy `/lock` route.
 *
 * Locking is now enforced by the root-level {@link LockGate} overlay (review
 * finding C1), which covers every authenticated screen whenever the lock store
 * reports `locked`. This route is kept only so any lingering navigation to
 * `/lock` resolves: it simply sends the user to the wallet, where the overlay
 * is shown if (and only if) the app is actually locked.
 */

import { Redirect } from 'expo-router';

export default function LockScreen() {
  return <Redirect href="/(tabs)" />;
}
