import { useEffect, useState } from 'react';
import { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Account, Balance, PayoutStatus } from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import { isAccountMissing, isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatSignedAmount } from '@/format/money';
import { t } from '@/i18n';
import { payableCurrencies } from '@/money/balance';
import {
  amountDecimals,
  buildPayoutBody,
  buildScheduleBody,
  formFromSchedule,
  parsePendingPayout,
  type PayoutForm,
  type PayoutFormError,
  payoutOutcomeUnknown,
  type PendingPayout,
  pendingPayoutStorageKey,
  type ScheduleForm,
  type ScheduleFormError,
} from '@/money/forms';
import { PayoutsTable } from '@/money/PayoutsTable';
import { moneyKeys, useAccount, useBalance, usePayoutPages } from '@/money/useMoney';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import {
  ORBIT_PAYOUT_INTERVALS,
  ORBIT_PAYOUT_STATUSES,
  ORBIT_WEEKLY_ANCHORS,
  payoutIntervalLabel,
  payoutStatusLabel,
  scheduleSummary,
  weekdayLabel,
} from '@/money/vocabulary';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { PermissionNotice, PageSkeleton } from '@/ui/states';
import {
  AccountMissing,
  ErrorNotice,
  Field,
  ListFooter,
  SetupPayments,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';

const ALL = 'all';
const statusOptions = () => [
  { value: ALL, label: t('payouts.allStatuses') },
  ...ORBIT_PAYOUT_STATUSES.map((status) => ({ value: status, label: payoutStatusLabel(status) })),
];
const intervalOptions = () =>
  ORBIT_PAYOUT_INTERVALS.map((interval) => ({
    value: interval,
    label: payoutIntervalLabel(interval),
  }));
const weekdayOptions = () =>
  ORBIT_WEEKLY_ANCHORS.map((day) => ({
    value: day,
    label: weekdayLabel(day),
  }));

const SCHEDULE_ERRORS: Record<ScheduleFormError, string> = {
  delay: 'schedule.invalid.delay',
  weekly: 'schedule.invalid.weekly',
  monthly: 'schedule.invalid.monthly',
};

function PayoutSchedule({ scope, account }: { scope: DashboardScope; account: Account }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const schedule = account.settings.payouts.schedule;
  const [form, setForm] = useState<ScheduleForm>(formFromSchedule(schedule));
  const [invalid, setInvalid] = useState<ScheduleFormError | null>(null);

  // A saved account resets the form to what the provider now reports.
  useEffect(() => {
    setForm(formFromSchedule(schedule));
    setInvalid(null);
  }, [schedule]);

  const save = useMutation({
    mutationFn: (body: Parameters<typeof dashboardApi.account.update>[1]) =>
      dashboardApi.account.update(scope, body),
    onSuccess: (saved) => {
      queryClient.setQueryData(moneyKeys.account(scope), saved);
      toast.success(t('schedule.saved'));
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });

  const submit = () => {
    const result = buildScheduleBody(form);
    setInvalid(result.ok ? null : result.error);
    if (result.ok) save.mutate(result.body);
  };
  const busy = save.isPending || !can('money');

  return (
    <Section title={t('schedule.title')} description={t('schedule.intro')}>
      <Field label={t('schedule.interval')} value={scheduleSummary(schedule)} />
      <View className="flex-row flex-wrap gap-4">
        <View className="w-56">
          <Choice
            label={t('schedule.interval')}
            value={form.interval}
            options={intervalOptions()}
            disabled={busy}
            onChange={(interval) =>
              setForm((prior) => ({ ...prior, interval: interval as ScheduleForm['interval'] }))
            }
          />
        </View>
        {form.interval === 'weekly' ? (
          <View className="w-56">
            <Choice
              label={t('schedule.weeklyAnchor')}
              value={form.weeklyAnchor || null}
              options={weekdayOptions()}
              disabled={busy}
              onChange={(day) =>
                setForm((prior) => ({
                  ...prior,
                  weeklyAnchor: day as ScheduleForm['weeklyAnchor'],
                }))
              }
            />
          </View>
        ) : null}
        {form.interval === 'monthly' ? (
          <View className="w-56">
            <FormField
              label={t('schedule.monthlyAnchor')}
              value={form.monthlyAnchor}
              onChange={(monthlyAnchor) => setForm((prior) => ({ ...prior, monthlyAnchor }))}
              keyboardType="number-pad"
              invalid={invalid === 'monthly'}
              disabled={busy}
            />
          </View>
        ) : null}
      </View>
      <FormField
        label={t('schedule.delayDays')}
        value={form.delayDays}
        onChange={(delayDays) => setForm((prior) => ({ ...prior, delayDays }))}
        hint={invalid ? t(SCHEDULE_ERRORS[invalid]) : t('schedule.delayHelp')}
        invalid={invalid !== null}
        keyboardType="number-pad"
        disabled={busy}
      />
      <View className="flex-row justify-end">
        <Button
          appearance="solid"
          tone="accent"
          loading={save.isPending}
          disabled={busy}
          onPress={submit}
        >
          {t('schedule.save')}
        </Button>
      </View>
    </Section>
  );
}

function payoutErrorText(error: PayoutFormError, currency: string): string {
  if (error === 'amount') {
    return t('payoutCreate.invalid.amount', { decimals: amountDecimals(currency) });
  }
  return t(error === 'exceeds' ? 'payoutCreate.invalid.exceeds' : 'payoutCreate.invalid.currency');
}

/**
 * Pay out, for a MANUAL schedule. The instruction and its `Idempotency-Key`
 * are kept (in storage, per scope) until the gateway answers, so a retry after
 * a lost response — or a reload — can never pay out twice.
 */
function PayOut({ scope, balance }: { scope: DashboardScope; balance: Balance }) {
  const queryClient = useQueryClient();
  const payable = payableCurrencies(balance);
  const storageKey = pendingPayoutStorageKey(scope);
  const [form, setForm] = useState<PayoutForm>({
    amount: '',
    currency: payable[0]?.currency ?? '',
  });
  const [invalid, setInvalid] = useState<PayoutFormError | null>(null);
  const [pending, setPending] = useState<PendingPayout | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (live) setPending(parsePendingPayout(raw));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [storageKey]);

  const forget = async () => {
    setPending(null);
    await AsyncStorage.removeItem(storageKey).catch(() => undefined);
  };

  const create = useMutation({
    mutationFn: async (operation: PendingPayout) => {
      setPending(operation);
      await AsyncStorage.setItem(storageKey, JSON.stringify(operation)).catch(() => undefined);
      return dashboardApi.payouts.create(scope, operation.body, operation.key);
    },
    onSuccess: async (payout) => {
      await forget();
      setError(null);
      setForm((prior) => ({ ...prior, amount: '' }));
      toast.success(t('payoutCreate.created', { status: payoutStatusLabel(payout.status) }));
      void queryClient.invalidateQueries({ queryKey: moneyKeys.all(scope) });
    },
    onError: async (failure) => {
      setError(describeError(failure, t('error.generic')));
      // An answer means nothing was paid out; only an unknown outcome keeps the key.
      if (!payoutOutcomeUnknown(failure)) await forget();
    },
  });

  const submit = () => {
    if (pending) {
      create.mutate(pending);
      return;
    }
    const result = buildPayoutBody(form, payable);
    setInvalid(result.ok ? null : result.error);
    if (result.ok) create.mutate({ key: Crypto.randomUUID(), body: result.body });
  };

  const selected = payable.find((entry) => entry.currency === form.currency);
  const locked = pending !== null || create.isPending;

  return (
    <Section title={t('payoutCreate.title')} description={t('payoutCreate.intro')}>
      {error ? (
        <Admonition type="error">
          <AdmonitionText>{error}</AdmonitionText>
        </Admonition>
      ) : null}
      {pending ? (
        <Admonition type="info">
          <AdmonitionText>
            {`${t('payoutCreate.retryHelp')} ${formatSignedAmount(
              pending.body.amount,
              pending.body.currency,
            )}`}
          </AdmonitionText>
        </Admonition>
      ) : null}
      {!payable.length && !pending ? (
        <Text variant="body-2-regular" className="text-muted-foreground">
          {t('payoutCreate.nothingAvailable')}
        </Text>
      ) : (
        <>
          <View className="flex-row flex-wrap gap-4">
            <View className="w-56">
              <Choice
                label={t('payoutCreate.currency')}
                value={form.currency || null}
                options={payable.map((entry) => ({ value: entry.currency, label: entry.currency }))}
                disabled={locked}
                onChange={(currency) => setForm((prior) => ({ ...prior, currency }))}
              />
            </View>
            <View className="flex-1 min-w-56">
              <FormField
                label={t('payoutCreate.amount')}
                value={form.amount}
                onChange={(amount) => setForm((prior) => ({ ...prior, amount }))}
                keyboardType="decimal-pad"
                invalid={invalid !== null}
                hint={
                  invalid
                    ? payoutErrorText(invalid, form.currency)
                    : selected
                      ? t('payoutCreate.available', {
                          amount: formatSignedAmount(selected.amount, selected.currency),
                        })
                      : undefined
                }
                disabled={locked}
              />
            </View>
          </View>
          <View className="flex-row justify-end">
            <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
              {pending ? t('payoutCreate.retry') : t('payoutCreate.submit')}
            </Button>
          </View>
        </>
      )}
    </Section>
  );
}

function ManualPayout({ scope }: { scope: DashboardScope }) {
  const balance = useBalance(scope);
  if (balance.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('payoutCreate.title')} />;
  if (balance.isError) {
    return <ErrorNotice error={balance.error} onRetry={() => void balance.refetch()} />;
  }
  if (balance.data === null) return null;
  return <PayOut scope={scope} balance={balance.data} />;
}

function PayoutList({ scope }: { scope: DashboardScope }) {
  const [status, setStatus] = useState<PayoutStatus | null>(null);
  const pages = usePayoutPages(scope, status);
  let body: React.ReactNode;
  if (pages.isPending) {
    body = <PageSkeleton variant="table" rows={3} accessibilityLabel={t('payouts.list')} />;
  } else if (pages.isError) {
    body = isAccountMissing(pages.error) ? (
      <AccountMissing environment={scope.environment} />
    ) : (
      <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />
    );
  } else {
    body = (
      <View className="gap-4">
        <PayoutsTable
          payouts={pages.data.pages.flatMap((page) => page.data)}
          empty={
            <EmptyState
              variant="compact"
              title={t('payouts.empty.title')}
              description={t('payouts.empty.body')}
            />
          }
        />
        <ListFooter pages={pages} />
      </View>
    );
  }
  return (
    <Section
      title={t('payouts.list')}
      actions={
        <View className="w-56">
          <Choice
            size="sm"
            label={t('payouts.filter')}
            value={status ?? ALL}
            options={statusOptions()}
            onChange={(next) => setStatus(next === ALL ? null : (next as PayoutStatus))}
          />
        </View>
      }
    >
      {body}
    </Section>
  );
}

function Payouts({ scope }: { scope: DashboardScope }) {
  const account = useAccount(scope);
  const { can } = useDashboardPermissions();
  if (account.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('payouts.title')} />;
  if (account.isError) {
    if (isMerchantMissing(account.error)) return <SetupPayments environment={scope.environment} />;
    return <ErrorNotice error={account.error} onRetry={() => void account.refetch()} />;
  }
  if (account.data === null) return <AccountMissing environment={scope.environment} />;
  const manual = account.data.settings.payouts.schedule?.interval === 'manual';
  return (
    <View className="gap-6">
      <PermissionNotice action="money" />
      {manual && can('money') ? <ManualPayout scope={scope} /> : null}
      <PayoutList scope={scope} />
      <PayoutSchedule scope={scope} account={account.data} />
    </View>
  );
}

export default function PayoutsScreen() {
  return (
    <OrbitScreen title={t('payouts.title')} description={t('payouts.description')}>
      {({ scope }) => <Payouts key={`${scope.applicationId}:${scope.environment}`} scope={scope} />}
    </OrbitScreen>
  );
}
