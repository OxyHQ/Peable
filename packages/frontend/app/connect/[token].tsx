/**
 * Seller FairCoin onboarding — the Peable-hosted page a marketplace's
 * onboarding link opens (`https://peable.to/connect/<token>`, ADR 0012 D3).
 *
 * A platform (Mercaria) wants to pay this seller's sales in FairCoin straight to
 * the seller's own wallet. Only the SELLER can say which key receives them, so
 * the key is registered here, in the seller's own Oxy session — never by the
 * platform. The Gateway refuses anyone but the Oxy user the account names.
 *
 * The key registered is the ACTIVE POCKET's account xpub: a PUBLIC key, so this
 * screen never touches spend capability. A pocket the seller also uses for
 * personal receipts would share the address chain the Gateway derives from, so
 * the screen asks for a dedicated pocket and makes the seller confirm it.
 *
 * Capability over platform: a device with no wallet for the link's network
 * (the browser build, a fresh install) gets a paste field for a watch-only key
 * instead of a dead end — the same keyless path the rest of the wallet takes.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useAuth } from '@oxy.so/services/ui/client';
import type { ConnectOnboarding } from '@peable.to/shared-types';
import { SafeAreaView } from '../../src/ui/safe-area-view';
import { ScreenHeader, Button } from '../../src/ui/components';
import { getActiveAccountXpub, useWalletStore } from '../../src/wallet/wallet-store';
import {
  ConnectOnboardingError,
  getConnectOnboarding,
  registerConnectKey,
} from '../../src/services/gateway-client';
import { t } from '../../src/i18n';

const SECTION_LABEL = 'text-muted-foreground text-xs font-semibold uppercase tracking-wider';

type Phase = 'loading' | 'ready' | 'registering' | 'done' | 'error';

/** One message per refusal the Gateway can give, by status. */
function messageFor(error: unknown, platform: string): string {
  if (!(error instanceof ConnectOnboardingError)) return t('connect.error.generic');
  switch (error.status) {
    case 404:
      return t('connect.error.notFound');
    case 410:
      return t('connect.error.expired', { platform });
    case 403:
      return t('connect.error.wrongSeller');
    case 409:
      return t('connect.error.conflict');
    case 422:
      return t('connect.error.invalidKey');
    default:
      return t('connect.error.generic');
  }
}

export default function ConnectOnboardingScreen() {
  const router = useRouter();
  const { isAuthenticated, signIn } = useAuth();
  const { token } = useLocalSearchParams<{ token?: string }>();

  const walletReady = useWalletStore((s) => s.initialized);
  const walletNetwork = useWalletStore((s) => s.network);
  const activeAccount = useWalletStore((s) => s.activeAccount);
  const pockets = useWalletStore((s) => s.pockets);

  const [phase, setPhase] = useState<Phase>('loading');
  const [onboarding, setOnboarding] = useState<ConnectOnboarding | null>(null);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pasted, setPasted] = useState('');

  const platformName = onboarding?.platform.name ?? '';

  useEffect(() => {
    if (!isAuthenticated || !token) return;
    let canceled = false;
    setPhase('loading');
    getConnectOnboarding(token)
      .then((result) => {
        if (canceled) return;
        setOnboarding(result);
        setPhase('ready');
      })
      .catch((caught: unknown) => {
        if (canceled) return;
        setError(messageFor(caught, ''));
        setPhase('error');
      });
    return () => {
      canceled = true;
    };
  }, [isAuthenticated, token]);

  // The active pocket's PUBLIC account key — only when this wallet is on the
  // link's network. A mainnet pocket must never be offered to a testnet store.
  const walletXpub =
    onboarding && walletReady && walletNetwork === onboarding.network
      ? getActiveAccountXpub()
      : null;
  const pocketName = pockets.find((pocket) => pocket.account === activeAccount)?.name ?? '';
  const keyToRegister = walletXpub ?? pasted.trim();

  const register = useCallback(async () => {
    if (!token || !keyToRegister) return;
    setPhase('registering');
    setError('');
    try {
      await registerConnectKey(token, keyToRegister);
      setPhase('done');
    } catch (caught: unknown) {
      setError(messageFor(caught, platformName));
      // A refusal of THIS key (in use, not watch-only) leaves the link usable;
      // anything else ends the flow.
      const retryable =
        caught instanceof ConnectOnboardingError &&
        (caught.status === 409 || caught.status === 422);
      setPhase(retryable ? 'ready' : 'error');
    }
  }, [token, keyToRegister, platformName]);

  const backToPlatform = useCallback(() => {
    if (onboarding) void Linking.openURL(onboarding.returnUrl);
  }, [onboarding]);

  if (!isAuthenticated) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom', 'left', 'right']}>
        <ScreenHeader title={t('connect.title')} onBack={() => router.back()} />
        <View className="flex-1 justify-center gap-4 px-6">
          <Text className="text-foreground text-xl font-semibold">{t('connect.signInTitle')}</Text>
          <Text className="text-muted-foreground">{t('connect.signInBody')}</Text>
          <Button title={t('connect.signIn')} onPress={() => void signIn()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title={t('connect.title')} onBack={() => router.back()} />
      <ScrollView contentContainerClassName="gap-4 px-6 pb-10">
        {phase === 'loading' && <ActivityIndicator className="mt-10" />}

        {phase === 'error' && <Text className="text-destructive mt-6">{error}</Text>}

        {phase === 'done' && onboarding && (
          <View className="gap-4 mt-6">
            <Text className="text-foreground text-xl font-semibold">{t('connect.doneTitle')}</Text>
            <Text className="text-muted-foreground">
              {t('connect.doneBody', { platform: platformName })}
            </Text>
            <Button
              title={t('connect.return', { platform: platformName })}
              onPress={backToPlatform}
            />
          </View>
        )}

        {(phase === 'ready' || phase === 'registering') && onboarding && (
          <View className="gap-4 mt-4">
            <Text className="text-foreground text-lg">
              {t('connect.asks', { platform: platformName })}
            </Text>
            <View className="gap-1">
              <Text className={SECTION_LABEL}>{t('connect.network')}</Text>
              <Text className="text-foreground">{onboarding.network}</Text>
            </View>
            <Text className="text-muted-foreground">
              {t('connect.custody', { platform: platformName })}
            </Text>

            {walletXpub ? (
              <View className="gap-3">
                <View className="gap-1">
                  <Text className={SECTION_LABEL}>{t('connect.pocket')}</Text>
                  <Text className="text-foreground text-base font-semibold">{pocketName}</Text>
                </View>
                <Text className="text-muted-foreground">
                  {t('connect.dedicated', { platform: platformName })}
                </Text>
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: confirmed }}
                  onPress={() => setConfirmed((value) => !value)}
                  className="flex-row items-center gap-3"
                >
                  <Text className="text-foreground text-lg">{confirmed ? '☑' : '☐'}</Text>
                  <Text className="text-foreground flex-1">
                    {t('connect.confirmDedicated', { platform: platformName })}
                  </Text>
                </Pressable>
                <Button
                  title={t('connect.managePockets')}
                  variant="secondary"
                  onPress={() => router.push('/pockets')}
                />
              </View>
            ) : (
              <View className="gap-2">
                <Text className={SECTION_LABEL}>{t('connect.pasteTitle')}</Text>
                <Text className="text-muted-foreground">
                  {t('connect.pasteBody', { network: onboarding.network })}
                </Text>
                <TextInput
                  accessibilityLabel={t('connect.pasteLabel')}
                  className="border border-border rounded-xl p-3 text-foreground"
                  value={pasted}
                  onChangeText={setPasted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={phase === 'ready'}
                />
              </View>
            )}

            {!!error && <Text className="text-destructive">{error}</Text>}

            <Button
              title={t('connect.register', { platform: platformName })}
              onPress={() => void register()}
              loading={phase === 'registering'}
              disabled={phase === 'registering' || !keyToRegister || (!!walletXpub && !confirmed)}
            />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
