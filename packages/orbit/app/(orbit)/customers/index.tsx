import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Customer } from '@peable.to/shared-types';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeBalance } from '@/billing/amount';
import { LoadMore } from '@/billing/BillingParts';
import { useCustomerPages } from '@/billing/useBilling';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';

function CustomerRow({ customer }: { customer: Customer }) {
  const router = useRouter();
  const balance = describeBalance(customer.balance, customer.currency);
  return (
    <View className="gap-1 py-3 border-b border-border">
      <LinkButton
        size="sm"
        accessibilityLabel={`${t('customer.title')} ${customer.id}`}
        onPress={() => router.push({ pathname: '/customers/[id]', params: { id: customer.id } })}
      >
        {customer.name ?? customer.email ?? customer.id}
      </LinkButton>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
          {customer.id}
        </Text>
        {customer.email ? (
          <Text variant="caption-1-regular" selectable className="text-muted-foreground">
            {customer.email}
          </Text>
        ) : null}
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {formatInstant(customer.created)}
        </Text>
        {balance.amount ? (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t(`customer.balance.${balance.kind}`, { amount: balance.amount })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function CustomerList({ scope, email }: { scope: DashboardScope; email: string }) {
  const pages = useCustomerPages(scope, email);
  if (pages.isPending) return <Loading accessibilityLabel={t('customers.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const customers = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('customers.title')}>
      {customers.length ? (
        customers.map((customer) => <CustomerRow key={customer.id} customer={customer} />)
      ) : (
        <EmptyState
          variant="compact"
          title={t('customers.empty.title')}
          description={t('customers.empty.body')}
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

function EmailFilter({ onSearch }: { onSearch: (email: string) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <View className="flex-row items-end gap-2 min-w-72">
      <View className="flex-1">
        <FormField
          label={t('customers.email')}
          value={draft}
          onChange={setDraft}
          keyboardType="email-address"
          placeholder={t('customers.emailPlaceholder')}
        />
      </View>
      <Button appearance="outline" size="sm" onPress={() => onSearch(draft.trim())}>
        {t('customers.search')}
      </Button>
    </View>
  );
}

export default function CustomersScreen() {
  const [email, setEmail] = useState('');
  return (
    <OrbitScreen
      title={t('customers.title')}
      description={t('customers.description')}
      actions={<EmailFilter onSearch={setEmail} />}
    >
      {({ scope }) => <CustomerList scope={scope} email={email} />}
    </OrbitScreen>
  );
}
