import { Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { dashboardApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { PEABLE_WALLET_URL } from '../config';
import { t } from '../i18n';

/**
 * The owner's setup task while FairCoin cannot be received (ADR 0021 D5).
 * FairCoin is paid into the Peable wallet of the Oxy account that owns the
 * application — a person or an organization — and nothing in Orbit can create
 * it: only that account's holder can, in Peable (signed in as the account, or
 * acting as the organization). Read from the configuration's `faircoin` entry,
 * the gateway's own answer; renders nothing once the wallet can receive.
 */
export function FaircoinWalletSetup({ scope }: { scope: DashboardScope }) {
  // The same cache entry as Settings → Payment methods.
  const query = useQuery({
    queryKey: ['orbit', scope.applicationId, scope.environment, 'payment_method_configurations'],
    queryFn: () => dashboardApi.paymentMethodConfigurations.list(scope, { limit: 100 }),
  });
  const entry =
    query.data?.data.find((configuration) => configuration.is_default)?.faircoin ??
    query.data?.data[0]?.faircoin;
  if (!entry || entry.available) return null;
  if (entry.unavailable_reason === 'faircoin_wallet_missing') {
    return (
      <EmptyState
        testID="faircoin-wallet-setup"
        variant="compact"
        title={t('faircoinWallet.setupTitle')}
        description={t('faircoinWallet.setupBody')}
        action={{
          label: t('faircoinWallet.openPeable'),
          onPress: () => void Linking.openURL(PEABLE_WALLET_URL),
        }}
      />
    );
  }
  if (entry.unavailable_reason === 'faircoin_network_closed') {
    return (
      <EmptyState
        testID="faircoin-network-closed"
        variant="compact"
        title={t('faircoinWallet.networkClosedTitle')}
        description={t('faircoinWallet.networkClosedBody')}
      />
    );
  }
  return null;
}
