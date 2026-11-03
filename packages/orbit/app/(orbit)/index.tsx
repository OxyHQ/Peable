import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { formatAmount } from '@/format/money';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { PaymentsTable } from '@/payments/PaymentsTable';
import { summarizePayments } from '@/payments/summary';
import { usePaymentPages } from '@/payments/usePayments';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';

/** The sample is the first page of the list at the gateway's maximum page size. */
const SAMPLE_SIZE = 100;
const RECENT_ROWS = 5;

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <View className="flex-1 min-w-40 gap-1 rounded-2xl border border-border bg-card p-4">
      <Text variant="caption-1-medium" className="text-muted-foreground">
        {label}
      </Text>
      <Text variant="title-2-semibold">{value}</Text>
    </View>
  );
}

function Summary({ scope }: { scope: DashboardScope }) {
  const router = useRouter();
  // The same cache entry as a Payments list of this size, so moving between
  // the two screens does not refetch.
  const pages = usePaymentPages(scope, null, SAMPLE_SIZE);
  if (pages.isPending) return <Loading accessibilityLabel={t('home.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const first = pages.data.pages[0];
  const payments = first?.data ?? [];
  if (!payments.length) {
    return <EmptyState title={t('home.empty.title')} description={t('home.empty.body')} />;
  }
  const summary = summarizePayments(payments, first?.has_more === false);
  const since =
    summary.oldest === null ? '' : t('home.since', { date: formatInstant(summary.oldest) });

  return (
    <View className="gap-6">
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t(summary.complete ? 'home.sampleNoteComplete' : 'home.sampleNote', {
          count: summary.sampleSize,
          since,
        })}
      </Text>
      <View className="flex-row flex-wrap gap-4">
        <Stat label={t('home.succeeded')} value={summary.succeeded} />
        <Stat label={t('home.open')} value={summary.open} />
        <Stat label={t('home.unsuccessful')} value={summary.unsuccessful} />
        <Stat label={t('home.refunded')} value={summary.refunded} />
      </View>
      <Section title={t('home.volume')} description={t('home.volumeHelp')}>
        {summary.volume.length ? (
          <View className="flex-row flex-wrap gap-4">
            {summary.volume.map((row) => (
              <Stat
                key={row.currency}
                label={`${row.currency} · ${row.count}`}
                value={formatAmount(row.amount, row.currency)}
              />
            ))}
          </View>
        ) : (
          <Text variant="body-2-regular" className="text-muted-foreground">
            {t('home.noVolume')}
          </Text>
        )}
      </Section>
      <Section
        title={t('home.recent')}
        actions={
          <Button appearance="outline" size="sm" onPress={() => router.navigate('/payments')}>
            {t('home.viewAll')}
          </Button>
        }
      >
        <PaymentsTable payments={payments.slice(0, RECENT_ROWS)} />
      </Section>
    </View>
  );
}

export default function HomeScreen() {
  return (
    <OrbitScreen title={t('home.title')}>{({ scope }) => <Summary scope={scope} />}</OrbitScreen>
  );
}
