/**
 * Root-level lock overlay (review finding C1).
 *
 * Renders the PIN screen ON TOP of the entire app whenever the lock store says
 * the app is locked. Because it covers every route, there is no way to reach an
 * authenticated screen while locked — not via a direct tab navigation and not
 * via a deep link. It also defers wallet key loading: on a wallet that has a
 * PIN, `initialize` is NOT called at boot; it runs here only after a correct
 * unlock, so keys and the SPV client are never brought up behind the lock.
 */

import { useCallback } from 'react';
import { View } from 'react-native';
import { useLockStore } from '../../wallet/lock-store';
import { useWalletStore } from '../../wallet/wallet-store';
import { LockScreenContent } from './LockScreenContent';

export function LockGate() {
  const locked = useLockStore((s) => s.locked);
  const resolved = useLockStore((s) => s.resolved);
  const unlock = useLockStore((s) => s.unlock);
  const reloadActiveWallet = useWalletStore((s) => s.reloadActiveWallet);

  const handleUnlock = useCallback(() => {
    // Bring the wallet up only AFTER a successful unlock. If boot deferred
    // initialization (PIN present) or auto-lock tore the wallet down (M1),
    // reload the active wallet now — wallet-type-aware (identity / BIP39 /
    // watch-only, see `reloadActiveWallet`) — and initialize it; if the
    // wallet is still initialized (no-PIN path), this is a cheap no-op.
    const run = async () => {
      if (useWalletStore.getState().initialized) {
        unlock();
        return;
      }
      // Lift the lock the instant persisted state is hydrated (onReady), so the
      // wallet is usable immediately after PIN entry; the SPV/P2P sync then
      // continues in the background. If init fails during hydration onReady
      // never fires, so unlock below still lifts the overlay (the wallet error
      // state surfaces the failure) rather than trapping the user behind it.
      await reloadActiveWallet(unlock);
      if (!useWalletStore.getState().initialized) {
        unlock();
      }
    };
    // The unlock transition must happen regardless of initialization outcome,
    // so surface nothing here — a failed init lands in the wallet error state.
    void run().catch(() => {
      unlock();
    });
  }, [reloadActiveWallet, unlock]);

  // Render nothing until boot has decided whether a PIN exists (avoids a flash
  // of the lock screen on wallets with no PIN) and once unlocked.
  if (!resolved || !locked) {
    return null;
  }

  return (
    <View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      // Sit above all routed content; capture all touches so nothing behind it
      // is interactable while locked.
      pointerEvents="auto"
    >
      <LockScreenContent onUnlock={handleUnlock} />
    </View>
  );
}
