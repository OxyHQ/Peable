/**
 * The receive gate (`receive-gate.ts`) of the open wallet, for any screen that
 * would show a receive address (R6-1): show one only while it is `open`.
 */
import { useShallow } from 'zustand/react/shallow';
import { type ReceiveGate, receiveGate } from './receive-gate';
import { useWalletStore } from './wallet-store';

export function useReceiveGate(): ReceiveGate {
  const input = useWalletStore(
    useShallow((s) => ({
      activeWalletId: s.activeWalletId,
      identityReceiveConfirmed: s.identityReceiveConfirmed,
      socialReceiveKeyMismatch: s.socialReceiveKeyMismatch,
      adoptedWalletUnconfirmed: s.adoptedWalletUnconfirmed,
    })),
  );
  return receiveGate(input);
}
