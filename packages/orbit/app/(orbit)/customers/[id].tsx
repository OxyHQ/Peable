import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Customer } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { describeBalance, formatSignedAmount } from '@/billing/amount';
import { InvoiceRow, LoadMore, RowList, SubscriptionRow } from '@/billing/BillingParts';
import { useCustomer, useInvoicePages, useSubscriptionPages } from '@/billing/useBilling';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';

function Subscriptions({ scope, customer }: { scope: DashboardScope; customer: Customer }) {
  const pages = useSubscriptionPages(scope, 'all', customer.id);
  if (pages.isPending) return <Loading accessibilityLabel={t('subscriptions.title')} />;
  if (pages.isError)
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('subscriptions.title')}>
      <RowList
        items={rows.map((row) => <SubscriptionRow key={row.id} subscription={row} />)}
        empty={t('customer.noSubscriptions')}
      />
      <LoadMore
        visible={pages.hasNextPage}
        loading={pages.isFetchingNextPage}
        onPress={() => void pages.fetchNextPage()}
      />
    </Section>
  );
}

function Invoices({ scope, customer }: { scope: DashboardScope; customer: Customer }) {
  const pages = useInvoicePages(scope, null, customer.id);
  if (pages.isPending) return <Loading accessibilityLabel={t('invoices.title')} />;
  if (pages.isError)
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('invoices.title')}>
      <RowList
        items={rows.map((row) => <InvoiceRow key={row.id} invoice={row} />)}
        empty={t('customer.noInvoices')}
      />
      <LoadMore
        visible={pages.hasNextPage}
        loading={pages.isFetchingNextPage}
        onPress={() => void pages.fetchNextPage()}
      />
    </Section>
  );
}

function CustomerDetail({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useCustomer(scope, id);
  if (query.isPending) return <Loading accessibilityLabel={t('customer.title')} />;
  if (query.isError) {
    if (isMerchantMissing(query.error)) {
      return (
        <EmptyState
          title={t('customer.notFound')}
          description={describeError(query.error, t('customer.notFound'))}
        />
      );
    }
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  const { customer, balance, entitlements } = query.data;
  const held = describeBalance(customer.balance, customer.currency);
  return (
    <View className="gap-6">
      <Text variant="title-1-bold" selectable>
        {customer.name ?? customer.email ?? customer.id}
      </Text>
      <Section title={t('customer.details')}>
        <Field label={t('customer.field.id')} value={customer.id} mono />
        <Field label={t('customer.field.email')} value={customer.email ?? '—'} />
        <Field label={t('customer.field.currency')} value={customer.currency ?? '—'} />
        <Field
          label={t('customer.field.balance')}
          value={
            held.amount
              ? t(`customer.balance.${held.kind}`, { amount: held.amount })
              : t('customer.balance.none')
          }
        />
        {customer.test_clock ? (
          <Field label={t('customer.field.testClock')} value={customer.test_clock} mono />
        ) : null}
        <Field label={t('customer.field.created')} value={formatInstant(customer.created)} />
      </Section>
      <Section title={t('customer.entitlements')} description={t('customer.entitlementsIntro')}>
        {entitlements.data.length ? (
          <View className="flex-row flex-wrap gap-2">
            {entitlements.data.map((entitlement) => (
              <Badge
                key={entitlement.id}
                appearance="subtle"
                tone="success"
                size="label-small"
                content={entitlement.lookup_key}
              />
            ))}
          </View>
        ) : (
          <Text variant="body-2-regular" className="text-muted-foreground">
            {t('customer.noEntitlements')}
          </Text>
        )}
      </Section>
      <Subscriptions scope={scope} customer={customer} />
      <Invoices scope={scope} customer={customer} />
      <Section title={t('customer.balanceTransactions')}>
        <RowList
          items={balance.data.map((entry) => (
            <View
              key={entry.id}
              className="flex-row flex-wrap gap-x-4 gap-y-1 py-2 border-b border-border"
            >
              <Text variant="body-2-semibold" selectable>
                {formatSignedAmount(entry.amount, entry.currency)}
              </Text>
              <Text variant="body-2-regular" className="text-muted-foreground">
                {t(`balance.type.${entry.type}`)}
              </Text>
              <Text variant="caption-1-regular" className="text-muted-foreground">
                {t('balance.after', {
                  amount: formatSignedAmount(entry.ending_balance, entry.currency),
                })}
              </Text>
              <Text variant="caption-1-regular" className="text-muted-foreground">
                {formatInstant(entry.created)}
              </Text>
            </View>
          ))}
          empty={t('customer.noBalanceTransactions')}
        />
      </Section>
    </View>
  );
}

export default function CustomerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return (
    <OrbitScreen
      title={t('customer.title')}
      actions={
        <Button
          appearance="plain"
          size="sm"
          leadingIcon={RiArrowLeftLine}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/customers'))}
        >
          {t('nav.customers')}
        </Button>
      }
    >
      {({ scope }) => (id ? <CustomerDetail scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
