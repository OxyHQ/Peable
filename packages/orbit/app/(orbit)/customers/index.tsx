import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Customer } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { Text } from '@oxy.so/bloom/typography';
import type { DashboardScope } from '@/api/dashboard';
import { describeBalance } from '@/billing/amount';
import { useCustomerPages } from '@/billing/useBilling';
import { t } from '@/i18n';
import { AmountText, RowLink, Timestamp } from '@/ui/data';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, ListFooter, OrbitScreen } from '@/ui/OrbitScreen';
import { ListEmpty, PageSkeleton } from '@/ui/states';

const COLUMNS = {
  name: { flex: 3, minWidth: 180 },
  email: { flex: 3, minWidth: 200 },
  balance: { flex: 2, minWidth: 130, align: 'end' },
  created: { flex: 2, minWidth: 140 },
} as const;

/** Customers, Stripe's table: who, their email, what they owe or hold in credit, when; a row opens one. */
function CustomersTable({ customers, filtered }: { customers: Customer[]; filtered: boolean }) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('customers.title')} minWidth={680} size="sm">
      <TableHeader>
        <TableColumn {...COLUMNS.name}>{t('list.column.customer')}</TableColumn>
        <TableColumn {...COLUMNS.email}>{t('list.column.email')}</TableColumn>
        <TableColumn {...COLUMNS.balance}>{t('list.column.balance')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('list.column.created')}</TableColumn>
      </TableHeader>
      <TableBody
        emptyState={
          filtered ? (
            <EmptyState
              variant="compact"
              title={t('customers.empty.title')}
              description={t('customers.empty.body')}
            />
          ) : (
            <ListEmpty
              title={t('customers.empty.firstTitle')}
              description={t('customers.empty.firstBody')}
              docs="cards"
            />
          )
        }
      >
        {customers.map((customer) => {
          const balance = describeBalance(customer.balance, customer.currency);
          return (
            <RowLink
              key={customer.id}
              accessibilityLabel={`${t('customer.title')} ${customer.id}`}
              onPress={() =>
                router.push({ pathname: '/customers/[id]', params: { id: customer.id } })
              }
            >
              <TableRow>
                <TableCell {...COLUMNS.name}>
                  <View>
                    <Text variant="body-2-medium" numberOfLines={1}>
                      {customer.name ?? customer.email ?? customer.id}
                    </Text>
                    <Text
                      variant="caption-1-regular"
                      numberOfLines={1}
                      className="font-mono text-muted-foreground"
                    >
                      {customer.id}
                    </Text>
                  </View>
                </TableCell>
                <TableCell {...COLUMNS.email}>
                  <Text variant="body-2-regular" numberOfLines={1}>
                    {customer.email ?? '—'}
                  </Text>
                </TableCell>
                <TableCell {...COLUMNS.balance}>
                  <AmountText>
                    {balance.amount
                      ? t(`customer.balance.${balance.kind}`, { amount: balance.amount })
                      : '—'}
                  </AmountText>
                </TableCell>
                <TableCell {...COLUMNS.created}>
                  <Timestamp seconds={customer.created} muted />
                </TableCell>
              </TableRow>
            </RowLink>
          );
        })}
      </TableBody>
    </Table>
  );
}

function CustomerList({ scope, email }: { scope: DashboardScope; email: string }) {
  const pages = useCustomerPages(scope, email);
  if (pages.isPending) {
    return <PageSkeleton variant="table" accessibilityLabel={t('customers.title')} />;
  }
  if (pages.isError)
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  const customers = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <CustomersTable customers={customers} filtered={email !== ''} />
      <ListFooter pages={pages} />
    </View>
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
      filters={<EmailFilter onSearch={setEmail} />}
    >
      {({ scope }) => <CustomerList scope={scope} email={email} />}
    </OrbitScreen>
  );
}
