import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { BalanceAmount, Payout } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Text } from '@oxy.so/bloom/typography';
import { isAccountMissing, type DashboardScope } from '@/api/dashboard';
import { formatAmount, sumBaseUnits } from '@/format/money';
import { nowSeconds } from '@/format/time';
import { t } from '@/i18n';
import { useBalance, usePayoutPages } from '@/money/useMoney';
import { startOfDay, volumeSince, type WindowVolume } from '@/payments/overview';
import { PaymentsTable } from '@/payments/PaymentsTable';
import { usePaymentPages } from '@/payments/usePayments';
import { OrbitScreen, Section } from '@/ui/OrbitScreen';
import { ErrorNotice, ListEmpty } from '@/ui/states';

/** The sample is the first page of the list at the gateway's maximum page size. */
const SAMPLE_SIZE = 100;
const RECENT_ROWS = 8;
const DAY = 86_400;

/** One of Home's summary tiles: a label, a figure, and the line under it. */
function Tile({
  label,
  value,
  note,
  loading,
  action,
}: {
  label: string;
  value?: string;
  note?: string;
  loading?: boolean;
  action?: ReactNode;
}) {
  return (
    <View className="flex-1 min-w-56 gap-1.5 rounded-2xl border border-border bg-card p-4">
      <Text variant="caption-1-medium" className="text-muted-foreground">
        {label}
      </Text>
      {loading ? (
        <Skeleton.Region label={label}>
          <Skeleton.Box width="60%" height={24} />
        </Skeleton.Region>
      ) : (
        <Text variant="title-3-semibold" style={{ fontVariant: ['tabular-nums'] }} selectable>
          {value ?? '—'}
        </Text>
      )}
      {note ? (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {note}
        </Text>
      ) : null}
      {action}
    </View>
  );
}

/** The window's main figure: its busiest currency, and how many more there are. */
function volumeFigure(window: WindowVolume): { value: string; extra: string | null } {
  const [first, ...rest] = window.volume;
  if (!first) return { value: '0', extra: null };
  return {
    value: formatAmount(first.amount, first.currency),
    extra: rest.length ? t('home.tile.multiCurrency', { count: rest.length }) : null,
  };
}

/** The first currency of a balance list (largest first is the provider's order). */
function balanceFigure(amounts: readonly BalanceAmount[]): string {
  const [first, ...rest] = amounts;
  if (!first) return '0';
  const figure = formatAmount(first.amount, first.currency.toUpperCase());
  return rest.length ? `${figure} ${t('home.tile.multiCurrency', { count: rest.length })}` : figure;
}

function inTransit(payouts: readonly Payout[]): string | null {
  const [first] = payouts;
  if (!first) return null;
  const same = payouts.filter((payout) => payout.currency === first.currency);
  return formatAmount(
    sumBaseUnits(same.map((payout) => payout.amount)),
    first.currency.toUpperCase(),
  );
}

function Overview({ scope }: { scope: DashboardScope }) {
  const router = useRouter();
  // The same cache entry as a Payments list of this size, so moving between
  // the two screens does not refetch.
  const pages = usePaymentPages(scope, null, SAMPLE_SIZE);
  const balance = useBalance(scope);
  const payouts = usePayoutPages(scope, 'in_transit');

  const now = nowSeconds();
  const first = pages.data?.pages[0];
  const payments = first?.data ?? [];
  const complete = first?.has_more === false;
  const today = volumeSince(payments, startOfDay(now), complete);
  const week = volumeSince(payments, now - 7 * DAY, complete);
  const todayFigure = volumeFigure(today);
  const weekFigure = volumeFigure(week);
  const floorNote = (window: WindowVolume, extra: string | null) =>
    [extra, window.covered ? null : t('home.tile.sampleNote', { count: payments.length })]
      .filter(Boolean)
      .join(' · ') || undefined;

  const noAccount =
    (balance.isSuccess && balance.data === null) ||
    (payouts.isError && isAccountMissing(payouts.error));
  const transit = payouts.data ? inTransit(payouts.data.pages.flatMap((page) => page.data)) : null;

  return (
    <View className="gap-6">
      {/* A failure of one figure is its own banner; the rest of Home still renders. */}
      {balance.isError ? (
        <ErrorNotice error={balance.error} onRetry={() => void balance.refetch()} />
      ) : null}
      {payouts.isError && !isAccountMissing(payouts.error) ? (
        <ErrorNotice error={payouts.error} onRetry={() => void payouts.refetch()} />
      ) : null}
      <View className="flex-row flex-wrap gap-4">
        <Tile
          label={t('home.tile.grossToday')}
          loading={pages.isPending}
          value={pages.isSuccess ? todayFigure.value : undefined}
          note={pages.isSuccess ? floorNote(today, todayFigure.extra) : undefined}
        />
        <Tile
          label={t('home.tile.gross7d')}
          loading={pages.isPending}
          value={pages.isSuccess ? weekFigure.value : undefined}
          note={
            pages.isSuccess
              ? [
                  t('home.tile.succeededCount', { count: week.succeeded }),
                  floorNote(week, weekFigure.extra),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
        />
        <Tile
          label={t('home.tile.available')}
          loading={balance.isPending}
          value={
            noAccount ? undefined : balance.data ? balanceFigure(balance.data.available) : undefined
          }
          note={
            noAccount
              ? t('home.tile.noBalance')
              : balance.data?.pending.length
                ? `${t('home.tile.pending')}: ${balanceFigure(balance.data.pending)}`
                : undefined
          }
          action={
            noAccount ? (
              <Button appearance="plain" size="sm" onPress={() => router.navigate('/account')}>
                {t('money.accountMissing.action')}
              </Button>
            ) : undefined
          }
        />
        <Tile
          label={t('home.tile.payouts')}
          loading={payouts.isPending}
          value={noAccount ? undefined : (transit ?? t('home.tile.payoutsNone'))}
          note={noAccount ? t('home.tile.noBalance') : undefined}
        />
      </View>
      <Section
        title={t('home.activity')}
        actions={
          <Button appearance="outline" size="sm" onPress={() => router.navigate('/payments')}>
            {t('home.viewAll')}
          </Button>
        }
      >
        {pages.isError ? (
          <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />
        ) : (
          <PaymentsTable
            payments={payments.slice(0, RECENT_ROWS)}
            empty={
              pages.isPending ? (
                <Skeleton.Region label={t('home.activity')}>
                  <Skeleton.Box width="100%" height={120} />
                </Skeleton.Region>
              ) : (
                <ListEmpty
                  title={t('payments.empty.firstTitle')}
                  description={t('payments.empty.firstBody')}
                  action={{
                    label: t('payments.empty.createLink'),
                    onPress: () => router.navigate('/links/new'),
                  }}
                  docs="payments"
                />
              )
            }
          />
        )}
      </Section>
    </View>
  );
}

export default function HomeScreen() {
  return (
    <OrbitScreen title={t('home.title')}>{({ scope }) => <Overview scope={scope} />}</OrbitScreen>
  );
}
