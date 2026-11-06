import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { Customer } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Text } from '@oxy.so/bloom/typography';
import type { DashboardScope } from '@/api/dashboard';
import { describeBalance, formatSignedAmount } from '@/billing/amount';
import { InvoicesTable, RowList, SubscriptionsTable } from '@/billing/BillingParts';
import { CustomerLanguage } from '@/billing/CustomerLanguage';
import { useCustomer, useInvoicePages, useSubscriptionPages } from '@/billing/useBilling';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import {
  DetailHeader,
  DetailLayout,
  ErrorNotice,
  Field,
  ListFooter,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';
import { Timestamp } from '@/ui/data';
import { isNotFound, NotFound, PageSkeleton } from '@/ui/states';

function Subscriptions({ scope, customer }: { scope: DashboardScope; customer: Customer }) {
  const pages = useSubscriptionPages(scope, 'all', customer.id);
  if (pages.isPending)
    return <PageSkeleton variant="table" rows={3} accessibilityLabel={t('subscriptions.title')} />;
  if (pages.isError)
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('subscriptions.title')}>
      <SubscriptionsTable subscriptions={rows} empty={t('customer.noSubscriptions')} />
      <ListFooter pages={pages} />
    </Section>
  );
}

function Invoices({ scope, customer }: { scope: DashboardScope; customer: Customer }) {
  const pages = useInvoicePages(scope, null, customer.id);
  if (pages.isPending)
    return <PageSkeleton variant="table" rows={3} accessibilityLabel={t('invoices.title')} />;
  if (pages.isError)
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('invoices.title')}>
      <InvoicesTable invoices={rows} empty={t('customer.noInvoices')} />
      <ListFooter pages={pages} />
    </Section>
  );
}

function CustomerDetail({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useCustomer(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('customer.title')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('customer.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  const { customer, balance, entitlements } = query.data;
  const held = describeBalance(customer.balance, customer.currency);
  return (
    <View className="gap-6">
      <DetailHeader
        headline={customer.name ?? customer.email ?? customer.id}
        id={customer.id}
        facts={[
          ...(customer.email ? [{ label: t('list.column.email'), value: customer.email }] : []),
          { label: t('list.column.created'), value: <Timestamp seconds={customer.created} /> },
        ]}
      />
      <DetailLayout
        aside={
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
            <CustomerLanguage scope={scope} customer={customer} />
          </Section>
        }
      >
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
      </DetailLayout>
    </View>
  );
}

export default function CustomerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('customer.title')}>
      {({ scope }) => (id ? <CustomerDetail scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
