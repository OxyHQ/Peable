import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import type { Balance, BalanceTransactionType } from '@peable.to/shared-types';
import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { isAccountMissing, isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { formatOptionalAmount, formatSignedAmount } from '@/format/money';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { balanceRows, informationalRows, unresolvedMismatches } from '@/money/balance';
import { BalanceTransactionsTable } from '@/money/BalanceTransactionsTable';
import {
  useBalance,
  useBalanceTransactionPages,
  useReconciliationMismatches,
} from '@/money/useMoney';
import {
  balanceTransactionTypeLabel,
  mismatchKindLabel,
  ORBIT_BALANCE_TRANSACTION_TYPES,
} from '@/money/vocabulary';
import { Choice } from '@/ui/Choice';
import {
  AccountMissing,
  ErrorNotice,
  MerchantMissing,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';

const ALL = 'all';
const TYPE_OPTIONS = [
  { value: ALL, label: t('balances.allTypes') },
  ...ORBIT_BALANCE_TRANSACTION_TYPES.map((type) => ({
    value: type,
    label: balanceTransactionTypeLabel(type),
  })),
];

function Mismatches({ scope }: { scope: DashboardScope }) {
  const query = useReconciliationMismatches(scope);
  if (query.isPending) return null;
  if (query.isError) {
    if (isMerchantMissing(query.error) || isAccountMissing(query.error)) return null;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  const open = unresolvedMismatches(query.data.data);
  if (!open.length) return null;
  return (
    <AdmonitionRoot type="warning">
      <AdmonitionRow>
        <AdmonitionIcon />
        <AdmonitionContent>
          <Text variant="body-2-semibold">
            {t('balances.mismatches.title', { count: open.length })}
          </Text>
          <AdmonitionText>{t('balances.mismatches.body')}</AdmonitionText>
          {open.map((mismatch) => (
            <Text key={mismatch.id} variant="caption-1-regular" selectable className="font-mono">
              {t('balances.mismatches.row', {
                kind: mismatchKindLabel(mismatch.kind),
                object: mismatch.object_id ?? t('balances.mismatches.noObject'),
                at: formatInstant(mismatch.detected_at),
              })}
            </Text>
          ))}
        </AdmonitionContent>
      </AdmonitionRow>
    </AdmonitionRoot>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-1 min-w-40 gap-1">
      <Text variant="caption-1-medium" className="text-muted-foreground">
        {label}
      </Text>
      <Text variant="headline-semibold" selectable>
        {value}
      </Text>
    </View>
  );
}

function BalanceSummary({ balance }: { balance: Balance }) {
  const rows = balanceRows(balance);
  const informational = informationalRows(balance);
  const missing = t('money.notReported');
  return (
    <View className="gap-6">
      <Section title={t('balances.byCurrency')}>
        {rows.length ? (
          rows.map((row) => (
            <View
              key={row.currency}
              className="flex-row flex-wrap gap-4 py-3 border-b border-border"
            >
              <Figure label={t('balances.column.currency')} value={row.currency} />
              <Figure
                label={t('balances.available')}
                value={formatOptionalAmount(row.available, row.currency, missing)}
              />
              <Figure
                label={t('balances.pending')}
                value={formatOptionalAmount(row.pending, row.currency, missing)}
              />
            </View>
          ))
        ) : (
          <Text variant="body-2-regular" className="text-muted-foreground">
            {t('balances.noFunds')}
          </Text>
        )}
      </Section>
      {informational.length ? (
        <Section title={t('balances.informational')} description={t('balances.informationalHelp')}>
          {informational.map((row) => (
            <View key={row.currency} className="flex-row flex-wrap gap-4 py-3">
              <Figure label={t('balances.column.currency')} value={row.currency} />
              <Figure
                label={t('balances.informational')}
                value={formatSignedAmount(row.amount, row.currency)}
              />
            </View>
          ))}
        </Section>
      ) : null}
    </View>
  );
}

function Transactions({ scope }: { scope: DashboardScope }) {
  const [type, setType] = useState<BalanceTransactionType | null>(null);
  const pages = useBalanceTransactionPages(scope, type);
  let body: ReactNode;
  if (pages.isPending) {
    body = <Loading accessibilityLabel={t('balances.transactions')} />;
  } else if (pages.isError) {
    body = <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  } else {
    body = (
      <View className="gap-4">
        <BalanceTransactionsTable
          transactions={pages.data.pages.flatMap((page) => page.data)}
          empty={
            <EmptyState
              variant="compact"
              title={t('balances.empty.title')}
              description={t('balances.empty.body')}
            />
          }
        />
        {pages.hasNextPage ? (
          <View className="items-center">
            <Button
              appearance="outline"
              loading={pages.isFetchingNextPage}
              onPress={() => void pages.fetchNextPage()}
            >
              {t('action.loadMore')}
            </Button>
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <Section
      title={t('balances.transactions')}
      description={t('balances.transactionsIntro')}
      actions={
        <View className="w-56">
          <Choice
            size="sm"
            label={t('balances.filter')}
            value={type ?? ALL}
            options={TYPE_OPTIONS}
            onChange={(next) => setType(next === ALL ? null : (next as BalanceTransactionType))}
          />
        </View>
      }
    >
      {body}
    </Section>
  );
}

function Balances({ scope }: { scope: DashboardScope }) {
  const balance = useBalance(scope);
  if (balance.isPending) return <Loading accessibilityLabel={t('balances.title')} />;
  if (balance.isError) {
    if (isMerchantMissing(balance.error))
      return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={balance.error} onRetry={() => void balance.refetch()} />;
  }
  // No fiat account: say so and point at Account — never a row of zeros.
  if (balance.data === null) return <AccountMissing environment={scope.environment} />;
  return (
    <View className="gap-6">
      <Mismatches scope={scope} />
      <BalanceSummary balance={balance.data} />
      <Transactions scope={scope} />
    </View>
  );
}

export default function BalancesScreen() {
  return (
    <OrbitScreen title={t('balances.title')} description={t('balances.description')}>
      {({ scope }) => (
        <Balances key={`${scope.applicationId}:${scope.environment}`} scope={scope} />
      )}
    </OrbitScreen>
  );
}
