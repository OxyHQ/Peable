import { useEffect, useRef } from 'react';
import { router } from 'expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import { useWalletStore } from './wallet-store';

/**
 * Close the wallet when the person starts acting as a different account
 * (oxy ADR 0001): their own, or an organization's — from this app's account
 * switcher or from a sibling Oxy app, since the session follows the device's
 * active account.
 *
 * The open wallet belongs to the account it was derived for; the person's
 * wallet must never be shown, or spent from, while they act as an
 * organization, nor the organization's after they switch back. The entry
 * screen then derives the right one (or says what is missing), so this only
 * tears down and hands over.
 */
export function useWalletFollowsActingAccount(): void {
  const { user } = useAuth();
  const accountId = user?.id ?? null;
  const previous = useRef<string | null>(accountId);

  useEffect(() => {
    const before = previous.current;
    previous.current = accountId;
    if (before === null || accountId === null || before === accountId) return;
    useWalletStore.getState().closeWallet();
    router.replace('/');
  }, [accountId]);
}
