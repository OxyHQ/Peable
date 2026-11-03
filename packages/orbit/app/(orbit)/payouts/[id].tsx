import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Payout } from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { dashboardApi } from '@/api/client';
import { isAccountMissing, isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatSignedAmount } from '@/format/money';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { BalanceTransactionsTable } from '@/money/BalanceTransactionsTable';
import { moneyKeys, usePayout, usePayoutReconciliation } from '@/money/useMoney';
import { canCancelPayout } from '@/money/vocabulary';
import { AccountMissing, ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { PayoutStatusBadge } from '@/ui/StatusBadge';

function Reconciliation({ scope, payout }: { scope: DashboardScope; payout: Payout }) {
  const pages = usePayoutReconciliation(scope, payout.id);
  if (pages.isPending) return <Loading accessibilityLabel={t('payout.reconciliation')} />;
  if (pages.isError) {
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const first = pages.data.pages[0];
  const transactions = pages.data.pages.flatMap((page) => page.data);
  const currency = first?.currency ?? payout.currency;
  return (
    <Section title={t('payout.reconciliation')}>
      <Admonition type={first?.status === 'complete' ? 'info' : 'warning'}>
        <AdmonitionText>
          {first?.status === 'complete'
            ? t('payout.reconciliation.complete')
            : t('payout.reconciliation.pending')}
        </AdmonitionText>
      </Admonition>
      {first ? (
        <View>
          <Field label={t('payout.reconciliation.count')} value={String(first.summary.count)} />
          <Field
            label={t('payout.reconciliation.gross')}
            value={formatSignedAmount(first.summary.amount, currency)}
          />
          <Field
            label={t('payout.reconciliation.fee')}
            value={formatSignedAmount(first.summary.fee, currency)}
          />
          <Field
            label={t('payout.reconciliation.net')}
            value={formatSignedAmount(first.summary.net, currency)}
          />
        </View>
      ) : null}
      <BalanceTransactionsTable
        transactions={transactions}
        empty={
          <EmptyState variant="compact" title={t('payout.reconciliation.empty')} description="" />
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
    </Section>
  );
}

function PayoutDetail({ scope, payout }: { scope: DashboardScope; payout: Payout }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => dashboardApi.payouts.cancel(scope, payout.id),
    onSuccess: (canceled) => {
      queryClient.setQueryData(moneyKeys.payout(scope, payout.id), canceled);
      void queryClient.invalidateQueries({ queryKey: moneyKeys.all(scope) });
      toast.success(t('payout.canceled'));
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  const notSet = t('account.notSet');
  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap items-center gap-3">
        <Text variant="title-1-bold" selectable>
          {formatSignedAmount(payout.amount, payout.currency)}
        </Text>
        <PayoutStatusBadge status={payout.status} />
        {canCancelPayout(payout.status) ? (
          <Button
            appearance="outline"
            tone="danger"
            size="sm"
            loading={cancel.isPending}
            onPress={() => cancel.mutate()}
          >
            {t('payout.cancel')}
          </Button>
        ) : null}
      </View>
      <Section title={t('payout.details')}>
        <Field label={t('payout.field.id')} value={payout.id} mono />
        <Field
          label={t('payout.field.amount')}
          value={formatSignedAmount(payout.amount, payout.currency)}
        />
        <Field
          label={t('payout.field.status')}
          value={<PayoutStatusBadge status={payout.status} />}
        />
        <Field label={t('payout.field.arrival')} value={formatInstant(payout.arrival_date)} />
        <Field label={t('payout.field.method')} value={t(`payout.method.${payout.method}`)} />
        <Field label={t('payout.field.type')} value={t(`payout.type.${payout.type}`)} />
        <Field
          label={t('payout.field.origin')}
          value={t(payout.automatic ? 'payout.origin.automatic' : 'payout.origin.manual')}
        />
        {payout.failure_code ? (
          <Field label={t('payout.field.failureCode')} value={payout.failure_code} mono />
        ) : null}
        <Field label={t('payout.field.description')} value={payout.description ?? notSet} />
        <Field
          label={t('payout.field.statementDescriptor')}
          value={payout.statement_descriptor ?? notSet}
        />
        {payout.balance_transaction ? (
          <Field
            label={t('payout.field.balanceTransaction')}
            value={payout.balance_transaction}
            mono
          />
        ) : null}
        <Field label={t('payout.field.created')} value={formatInstant(payout.created)} />
      </Section>
      <Reconciliation scope={scope} payout={payout} />
    </View>
  );
}

function PayoutLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = usePayout(scope, id);
  if (query.isPending) return <Loading accessibilityLabel={t('payout.title')} />;
  if (query.isError) {
    if (isAccountMissing(query.error)) return <AccountMissing environment={scope.environment} />;
    // 404 means no payout with this id in this mode, or no merchant in this
    // mode at all; the gateway's own message says which.
    if (isMerchantMissing(query.error)) {
      return (
        <EmptyState
          title={t('payout.notFound')}
          description={describeError(query.error, t('payout.notFound'))}
        />
      );
    }
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <PayoutDetail scope={scope} payout={query.data} />;
}

export default function PayoutScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return (
    <OrbitScreen
      title={t('payout.title')}
      actions={
        <Button
          appearance="plain"
          size="sm"
          leadingIcon={RiArrowLeftLine}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/payouts'))}
        >
          {t('nav.payouts')}
        </Button>
      }
    >
      {({ scope }) => (id ? <PayoutLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
