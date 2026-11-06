/**
 * Re-reads the open wallet's social-receive cursor whenever the app comes back
 * to the foreground. While it was away, payers and FairCoin checkouts may have
 * been handed new addresses for this account; the wallet hears of that only by
 * asking (`requestSocialReceiveResync`). Mount once, high in the tree. The
 * wallet store also resyncs on its own bounded interval, after a social
 * payment lands, and when the Receive sheet opens.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { requestSocialReceiveResync } from '../wallet/wallet-store';

export function useSocialReceiveResync(): void {
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') requestSocialReceiveResync();
    });
    return () => {
      subscription.remove();
    };
  }, []);
}
