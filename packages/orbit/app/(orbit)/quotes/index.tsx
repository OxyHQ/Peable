import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { QuoteStatus } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { t } from '@/i18n';
import { QuotesTable, quoteStatusLabel } from '@/quotes/QuoteParts';
import { ORBIT_QUOTE_STATUSES } from '@/quotes/quoteForm';
import { useQuotePages } from '@/quotes/useQuotes';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, ListFooter, SetupPayments, OrbitScreen } from '@/ui/OrbitScreen';
import { ListEmpty, PageSkeleton } from '@/ui/states';

const ALL = 'all';
// Built at render: the language can change while Orbit is open.
const options = () => [
  { value: ALL, label: t('quotes.filter.all') },
  ...ORBIT_QUOTE_STATUSES.map((status) => ({ value: status, label: quoteStatusLabel(status) })),
];

function QuoteList({ scope, status }: { scope: DashboardScope; status: QuoteStatus | null }) {
  const router = useRouter();
  const { can } = useDashboardPermissions();
  const pages = useQuotePages(scope, status);
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('quotes.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <SetupPayments environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <QuotesTable
        quotes={rows}
        empty={
          status ? (
            <EmptyState
              variant="compact"
              title={t('quotes.empty.title')}
              description={t('quotes.empty.body')}
            />
          ) : (
            <ListEmpty
              title={t('quotes.empty.firstTitle')}
              description={t('quotes.empty.firstBody')}
              {...(can('money')
                ? { action: { label: t('quotes.new'), onPress: () => router.push('/quotes/new') } }
                : {})}
              docs="billing"
            />
          )
        }
      />
      <ListFooter pages={pages} />
    </View>
  );
}

export default function QuotesScreen() {
  const router = useRouter();
  const { can } = useDashboardPermissions();
  const [status, setStatus] = useState<QuoteStatus | null>(null);
  return (
    <OrbitScreen
      title={t('quotes.title')}
      description={t('quotes.description')}
      actions={
        <Button
          appearance="solid"
          tone="accent"
          disabled={!can('money')}
          onPress={() => router.push('/quotes/new')}
        >
          {t('quotes.new')}
        </Button>
      }
      filters={
        <View className="w-56">
          <Choice
            size="sm"
            label={t('quotes.filter')}
            value={status ?? ALL}
            options={options()}
            onChange={(next) => setStatus(next === ALL ? null : (next as QuoteStatus))}
          />
        </View>
      }
    >
      {({ scope }) => <QuoteList scope={scope} status={status} />}
    </OrbitScreen>
  );
}
