/**
 * Entry screen — Oxy-first onboarding (spec §4.2).
 *
 * Decides the entry route from Oxy auth state + the on-device identity:
 *   signed out          -> "Sign in with Oxy"
 *   signed in, keyless  -> "Set up your Oxy ID"
 *   signed in, native   -> derive the identity wallet -> PIN gate -> (tabs)
 *   no keystore         -> (tabs), read-only: activity, receive code, settings
 *   acting as an org    -> the ORGANIZATION's wallet, from its key (oxy ADR
 *                          0061), or the step that is missing in place:
 *                          set it up / add it in Commons, or only owners and
 *                          admins can (`WalletBlockedView`)
 *
 * This screen is the sole authority for the swap: it renders the pre-wallet
 * branches (sign in, create an Oxy ID) in place and sends the two that have a
 * wallet shell to show — full and read-only — into `(tabs)`.
 */

import { useCallback, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { Redirect, useFocusEffect } from 'expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import { getOrganizationPublicKey } from '@oxy.so/core/crypto';
import { useWalletStore, type IdentityInitResult } from '../src/wallet/wallet-store';
import { useLockStore } from '../src/wallet/lock-store';
import { hasPin } from '../src/storage/secure-store';
import { decideEntryRoute, type WalletBlock } from '../src/wallet/entry-route';
import {
  PERSONAL_SUBJECT,
  identityWalletIdOf,
  type IdentitySubject,
} from '../src/wallet/identity-wallet';
import { hasIdentityKeystore } from '../src/wallet/keystore';
import { decideActingSubject, resolveOrganizationWallet } from '../src/wallet/organization-wallet';
import { oxyServices } from '../src/services/oxy-services';
import { SignInView } from '../src/ui/components/SignInView';
import { CreateOxyIdView } from '../src/ui/components/CreateOxyIdView';
import { WalletBlockedView } from '../src/ui/components/WalletBlockedView';
import { t } from '../src/i18n';

/**
 * Which identity wallet the acting account opens, or why it opens none here.
 * A person's own account opens their wallet; acting as an organization opens
 * the ORGANIZATION's, only when this phone holds the key it publishes (or a
 * key it replaced — ADR 0002 keeps that one spendable, receive off).
 */
async function resolveWalletTarget(account: {
  id: string;
  kind?: string | null;
}): Promise<
  | { kind: 'open'; subject: IdentitySubject; publishedPublicKey?: string | null }
  | { kind: 'read-only' }
  | { kind: 'blocked'; block: WalletBlock }
> {
  const acting = decideActingSubject(account);
  if (acting.kind === 'personal') return { kind: 'open', subject: PERSONAL_SUBJECT };
  if (acting.kind === 'unsupported') return { kind: 'blocked', block: { kind: 'unsupported' } };

  const { accountId } = acting;
  const status = await resolveOrganizationWallet(accountId, {
    hasIdentityKeystore: hasIdentityKeystore(),
    readIdentityKey: (id) => oxyServices.accounts.identityKey.get(id),
    readDevicePublicKey: (id) => getOrganizationPublicKey(id),
  });
  switch (status.status) {
    case 'ready':
    case 'replaced-key':
      return {
        kind: 'open',
        subject: { kind: 'organization', accountId },
        publishedPublicKey: status.publishedPublicKey,
      };
    case 'read-only':
      return { kind: 'read-only' };
    default:
      return { kind: 'blocked', block: { kind: 'organization', accountId, status: status.status } };
  }
}

export default function IndexScreen() {
  const { isAuthResolved, isAuthenticated, user } = useAuth();
  const initializeFromIdentity = useWalletStore((s) => s.initializeFromIdentity);
  const closeWallet = useWalletStore((s) => s.closeWallet);
  const accountId = user?.id ?? null;
  const accountKind = user?.kind ?? null;
  const markNoPinUnlocked = useLockStore((s) => s.markNoPinUnlocked);
  const resolveInitialLock = useLockStore((s) => s.resolveInitialLock);

  const [identityInit, setIdentityInit] = useState<IdentityInitResult | null>(null);
  const [hasPinConfigured, setHasPinConfigured] = useState<boolean | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [block, setBlock] = useState<WalletBlock | null>(null);
  // A different acting account starts from nothing: never show the previous
  // account's block or probe result while this one's resolves. (State
  // adjusted during render, React's pattern for "reset when a prop changes".)
  const [bootedFor, setBootedFor] = useState(accountId);
  if (bootedFor !== accountId) {
    setBootedFor(accountId);
    setBlock(null);
    setIdentityInit(null);
    setHasPinConfigured(null);
  }

  const boot = useCallback(
    async (isCancelled: () => boolean) => {
      if (!isAuthResolved || !isAuthenticated || !accountId) return;
      try {
        const pinSet = await hasPin();
        const target = await resolveWalletTarget({ id: accountId, kind: accountKind });
        if (isCancelled()) return;
        if (target.kind !== 'open') {
          // Nothing of the PREVIOUS account's may stay open under this one.
          if (useWalletStore.getState().initialized) closeWallet();
          setBlock(target.kind === 'blocked' ? target.block : null);
          setHasPinConfigured(pinSet);
          setIdentityInit(target.kind === 'read-only' ? 'no-keystore' : null);
          markNoPinUnlocked();
          return;
        }
        setBlock(null);
        const walletId = identityWalletIdOf(target.subject);
        // An initialized wallet counts only if it is THIS account's: the
        // person may have switched between their own account and an
        // organization since it was opened.
        // Read the store NOW, not this render's snapshot: the awaits above
        // leave room for an account switch to have closed or replaced it.
        const live = useWalletStore.getState();
        const current = live.initialized && live.activeWalletId === walletId;
        if (live.initialized && !current) closeWallet();
        const result: IdentityInitResult = current
          ? 'initialized'
          : await initializeFromIdentity(() => {}, target.subject, target.publishedPublicKey);
        // Superseded: closed (another account switch) while deriving; the
        // boot that closed it decides what opens next.
        if (isCancelled() || result === 'superseded') return;
        if (result === 'no-identity' && target.subject.kind === 'organization') {
          // The key vanished between the check and the derivation (Commons
          // removed it, or an older Commons cannot answer for an
          // organization): this phone does not have it.
          setBlock({
            kind: 'organization',
            accountId: target.subject.accountId,
            status: 'not-on-device',
          });
          setHasPinConfigured(pinSet);
          markNoPinUnlocked();
          return;
        }
        setHasPinConfigured(pinSet);
        setIdentityInit(result);
        if (result === 'initialized') {
          if (!pinSet) markNoPinUnlocked();
          else resolveInitialLock(pinSet);
        } else {
          markNoPinUnlocked();
        }
      } catch (err: unknown) {
        if (!isCancelled()) {
          setErrorMsg(err instanceof Error ? err.message : t('index.error.load'));
        }
      }
    },
    [
      isAuthResolved,
      isAuthenticated,
      accountId,
      accountKind,
      initializeFromIdentity,
      closeWallet,
      markNoPinUnlocked,
      resolveInitialLock,
    ],
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void boot(() => cancelled);
      return () => {
        cancelled = true;
      };
    }, [boot]),
  );

  // "Check again": after the owner set the organization's wallet up in
  // Commons. Coming back from Commons does not re-focus this screen.
  const retry = useCallback(() => {
    setBlock(null);
    setIdentityInit(null);
    void boot(() => false);
  }, [boot]);

  if (errorMsg) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Text className="text-destructive text-base text-center mb-4">{errorMsg}</Text>
        <Text className="text-muted-foreground text-sm text-center">{t('index.error.help')}</Text>
      </View>
    );
  }

  const route = decideEntryRoute({
    isAuthResolved,
    isAuthenticated,
    identityInit,
    hasPinConfigured,
    block,
  });

  switch (route.kind) {
    case 'ready':
      return <Redirect href="/(tabs)" />;
    case 'needs-pin':
      return <Redirect href="/onboarding/pin-setup" />;
    case 'signin':
      return <SignInView />;
    case 'create-identity':
      return <CreateOxyIdView />;
    case 'blocked':
      return <WalletBlockedView block={route.block} onRetry={retry} />;
    // No keystore here, so no identity seed, so no signing — but the SHELL is
    // still the right place: `(tabs)` admits the `read-only` capability
    // (`src/wallet/capability.ts`) and each tab renders what needs no key.
    //
    // This used to render the read-only view IN PLACE, because `(tabs)` then
    // admitted only an initialized wallet and redirecting there bounced straight
    // back to `/`. In place meant outside the shell: a web visitor lost the
    // navigation rail, Settings and every other tab. The bounce is gone because
    // the gate now asks about capability, not about `initialized`.
    case 'read-only':
      return <Redirect href="/(tabs)" />;
    // 'loading', and anything else not yet decided.
    default:
      return (
        <View className="flex-1 bg-background items-center justify-center">
          <ActivityIndicator size="large" color="#9ffb50" />
          <Text className="text-muted-foreground text-sm mt-4">{t('index.loading')}</Text>
        </View>
      );
  }
}
