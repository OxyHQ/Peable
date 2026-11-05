/**
 * Seller FairCoin onboarding — the Peable-hosted page a marketplace's
 * onboarding link opens (`https://peable.to/connect/<token>`, ADR 0012 D3).
 *
 * A platform (Mercaria) wants to pay this seller's sales in FairCoin straight to
 * the seller. They are paid into the Peable wallet of the seller's OWN Oxy
 * account (ADR 0021 D5) — the identity wallet this app already holds — so the
 * seller only confirms, in their own Oxy session; no key is chosen, pasted or
 * sent. The Gateway refuses anyone but the Oxy user the account names, and an
 * account that has no Peable wallet yet.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useAuth } from '@oxy.so/services/ui/client';
import type { ConnectOnboarding } from '@peable.to/shared-types';
import { SafeAreaView } from '../../src/ui/safe-area-view';
import { ScreenHeader, Button } from '../../src/ui/components';
import {
  ConnectOnboardingError,
  confirmConnectFaircoin,
  getConnectOnboarding,
} from '../../src/services/gateway-client';
import { t } from '../../src/i18n';

const SECTION_LABEL = 'text-muted-foreground text-xs font-semibold uppercase tracking-wider';

type Phase = 'loading' | 'ready' | 'confirming' | 'done' | 'error';

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
    default:
      return t('connect.error.generic');
  }
}

export default function ConnectOnboardingScreen() {
  const router = useRouter();
  const { isAuthenticated, signIn } = useAuth();
  const { token } = useLocalSearchParams<{ token?: string }>();

  const [phase, setPhase] = useState<Phase>('loading');
  const [onboarding, setOnboarding] = useState<ConnectOnboarding | null>(null);
  const [error, setError] = useState('');

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

  const confirm = useCallback(async () => {
    if (!token) return;
    setPhase('confirming');
    setError('');
    try {
      await confirmConnectFaircoin(token);
      setPhase('done');
    } catch (caught: unknown) {
      setError(messageFor(caught, platformName));
      // No Peable wallet yet (409) leaves the link usable once the seller has one.
      const retryable = caught instanceof ConnectOnboardingError && caught.status === 409;
      setPhase(retryable ? 'ready' : 'error');
    }
  }, [token, platformName]);

  const backToPlatform = useCallback(() => {
    if (onboarding) void Linking.openURL(onboarding.return_url);
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

        {(phase === 'ready' || phase === 'confirming') && onboarding && (
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

            {!!error && <Text className="text-destructive">{error}</Text>}

            <Button
              title={t('connect.register', { platform: platformName })}
              onPress={() => void confirm()}
              loading={phase === 'confirming'}
              disabled={phase === 'confirming'}
            />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
