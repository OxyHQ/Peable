/**
 * Drives the Explorer realtime socket for the active network across the app's
 * lifetime. Mount this once, high in the tree: it opens the socket for the
 * wallet's current network, follows network switches, and suspends the
 * connection while the app is backgrounded so no socket is held open off-screen.
 */

import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useWalletStore } from '../wallet/wallet-store';
import { explorerSocket } from '../services/explorer-socket';

export function useExplorerRealtime(): void {
  const network = useWalletStore((s) => s.network);

  // Foreground/background lifecycle. Runs once; the current network is read
  // imperatively from the store so this never captures a stale value.
  useEffect(() => {
    const applyState = (status: AppStateStatus) => {
      if (status === 'active') {
        explorerSocket.start(useWalletStore.getState().network);
      } else {
        explorerSocket.stop();
      }
    };
    applyState(AppState.currentState);
    const subscription = AppState.addEventListener('change', applyState);
    return () => {
      subscription.remove();
      explorerSocket.stop();
    };
  }, []);

  // Follow network switches without tearing the socket down and up. `setNetwork`
  // is a no-op while the socket is stopped (it just records the target network).
  useEffect(() => {
    explorerSocket.setNetwork(network);
  }, [network]);
}
