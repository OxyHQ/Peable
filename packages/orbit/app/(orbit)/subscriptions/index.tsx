import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { SubscriptionStatus } from '@peable.to/shared-types';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { SubscriptionsTable } from '@/billing/BillingParts';
import { ORBIT_SUBSCRIPTION_STATUSES, subscriptionStatusLabel } from '@/billing/status';
import { useSubscriptionPages } from '@/billing/useBilling';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, ListFooter, SetupPayments, OrbitScreen } from '@/ui/OrbitScreen';
import { ListEmpty, PageSkeleton } from '@/ui/states';

type Filter = SubscriptionStatus | 'all' | null;
const CURRENT = 'current';
// Built at render: the language can change while Orbit is open.
const options = () => [
  { value: CURRENT, label: t('subscriptions.filter.current') },
  { value: 'all', label: t('subscriptions.filter.all') },
  ...ORBIT_SUBSCRIPTION_STATUSES.map((status) => ({
    value: status,
    label: subscriptionStatusLabel(status),
  })),
];

function SubscriptionList({ scope, filter }: { scope: DashboardScope; filter: Filter }) {
  const router = useRouter();
  const pages = useSubscriptionPages(scope, filter);
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('subscriptions.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <SetupPayments environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <SubscriptionsTable
        subscriptions={rows}
        empty={
          filter && filter !== 'all' ? (
            <EmptyState
              variant="compact"
              title={t('subscriptions.empty.title')}
              description={t('subscriptions.empty.body')}
            />
          ) : (
            <ListEmpty
              title={t('subscriptions.empty.firstTitle')}
              description={t('subscriptions.empty.firstBody')}
              action={{
                label: t('subscriptions.empty.addProduct'),
                onPress: () => router.navigate('/products'),
              }}
              docs="billing"
            />
          )
        }
      />
      <ListFooter pages={pages} />
    </View>
  );
}

export default function SubscriptionsScreen() {
  const [filter, setFilter] = useState<Filter>(null);
  return (
    <OrbitScreen
      title={t('subscriptions.title')}
      description={t('subscriptions.description')}
      filters={
        <View className="w-56">
          <Choice
            size="sm"
            label={t('subscriptions.filter')}
            value={filter ?? CURRENT}
            options={options()}
            onChange={(next) => setFilter(next === CURRENT ? null : (next as Filter))}
          />
        </View>
      }
    >
      {({ scope }) => <SubscriptionList scope={scope} filter={filter} />}
    </OrbitScreen>
  );
}
