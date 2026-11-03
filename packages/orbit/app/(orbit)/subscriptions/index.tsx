import { useState } from 'react';
import { View } from 'react-native';
import type { SubscriptionStatus } from '@peable.to/shared-types';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { LoadMore, SubscriptionRow } from '@/billing/BillingParts';
import { ORBIT_SUBSCRIPTION_STATUSES, subscriptionStatusLabel } from '@/billing/status';
import { useSubscriptionPages } from '@/billing/useBilling';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';

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
  const pages = useSubscriptionPages(scope, filter);
  if (pages.isPending) return <Loading accessibilityLabel={t('subscriptions.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('subscriptions.title')}>
      {rows.length ? (
        rows.map((row) => <SubscriptionRow key={row.id} subscription={row} />)
      ) : (
        <EmptyState
          variant="compact"
          title={t('subscriptions.empty.title')}
          description={t('subscriptions.empty.body')}
        />
      )}
      <LoadMore
        visible={pages.hasNextPage}
        loading={pages.isFetchingNextPage}
        onPress={() => void pages.fetchNextPage()}
      />
    </Section>
  );
}

export default function SubscriptionsScreen() {
  const [filter, setFilter] = useState<Filter>(null);
  return (
    <OrbitScreen
      title={t('subscriptions.title')}
      description={t('subscriptions.description')}
      actions={
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
