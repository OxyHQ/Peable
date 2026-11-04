import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Transfer } from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { describeError } from '../api/transport';
import { formatAmount, normalizeCurrency } from '../format/money';
import { formatInstant } from '../format/time';
import { t } from '../i18n';
import { amountDecimals, payoutOutcomeUnknown } from '../money/forms';
import { useDashboardPermissions } from '../scope/useDashboardPermissions';
import { FormField } from '../ui/FormField';
import { ErrorNotice } from '../ui/OrbitScreen';
import { ToneBadge } from '../ui/StatusBadge';
import {
  canReverse,
  newReversalRef,
  parsePendingReversal,
  parseReversalAmount,
  type PendingReversal,
  pendingReversalStorageKey,
  type ReversalFormError,
  reversibleAmount,
  sellerPath,
} from './forms';
import { connectKeys, useReversals } from './useConnect';
import {
  reversalStatusLabel,
  reversalStatusTone,
  transferStatusLabel,
  transferStatusTone,
} from './vocabulary';
import { PageSkeleton } from '../ui/states';

const idOf = (reference: string | { id: string }) =>
  typeof reference === 'string' ? reference : reference.id;

function Reversals({ scope, transfer }: { scope: DashboardScope; transfer: Transfer }) {
  const query = useReversals(scope, transfer.id, true);
  if (query.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('connect.reversals')} />;
  if (query.isError)
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data.data.length) {
    return (
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('connect.reversals.none')}
      </Text>
    );
  }
  return (
    <View className="gap-2">
      {query.data.data.map((reversal) => (
        <View key={reversal.id} className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <ToneBadge
            tone={reversalStatusTone(reversal.status)}
            label={reversalStatusLabel(reversal.status)}
          />
          <Text variant="body-2-semibold">
            {formatAmount(reversal.amount, normalizeCurrency(reversal.currency))}
          </Text>
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {formatInstant(reversal.created)}
          </Text>
          <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
            {reversal.id} · {reversal.external_ref}
          </Text>
          {reversal.failure_message ? (
            <Text variant="caption-1-regular" selectable className="text-destructive">
              {reversal.failure_message}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const REVERSAL_ERRORS: Record<ReversalFormError, string> = {
  amount: 'connect.reverse.invalid.amount',
  exceeds: 'connect.reverse.invalid.exceeds',
};

/**
 * Take some or all of a settlement back. The instruction — its amount and its
 * `external_ref`, which is also the `Idempotency-Key` — is kept in storage
 * until the gateway answers, so a retry after a lost answer, or a reload, is
 * the same reversal and never a second one.
 */
function Reverse({ scope, transfer }: { scope: DashboardScope; transfer: Transfer }) {
  const queryClient = useQueryClient();
  const storageKey = pendingReversalStorageKey(scope, transfer.id);
  const currency = normalizeCurrency(transfer.currency);
  const [amount, setAmount] = useState('');
  const [invalid, setInvalid] = useState<ReversalFormError | null>(null);
  const [pending, setPending] = useState<PendingReversal | null>(null);

  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (live) setPending(parsePendingReversal(raw, transfer.id));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [storageKey, transfer.id]);

  const forget = () => {
    setPending(null);
    void AsyncStorage.removeItem(storageKey).catch(() => undefined);
  };

  const reverse = useMutation({
    mutationFn: (instruction: PendingReversal) =>
      dashboardApi.transfers.reverse(
        scope,
        transfer.id,
        instruction.body,
        instruction.body.external_ref,
      ),
    onSuccess: (updated) => {
      forget();
      setAmount('');
      toast.success(
        t('connect.reverse.done', {
          amount: formatAmount(updated.reversal.amount, currency),
        }),
      );
      void queryClient.invalidateQueries({ queryKey: connectKeys.all(scope) });
    },
    onError: (error) => {
      // A refusal is the gateway's answer: nothing was reversed, so the
      // instruction is dropped. No answer at all keeps it, to retry as is.
      if (!payoutOutcomeUnknown(error)) forget();
      toast.error(describeError(error, t('error.generic')));
    },
  });

  const submit = () => {
    if (pending) {
      reverse.mutate(pending);
      return;
    }
    const parsed = parseReversalAmount(amount, transfer);
    setInvalid(parsed.ok ? null : parsed.error);
    if (!parsed.ok) return;
    const instruction: PendingReversal = {
      transfer: transfer.id,
      body: { amount: parsed.body, external_ref: newReversalRef(Crypto.randomUUID()) },
    };
    setPending(instruction);
    void AsyncStorage.setItem(storageKey, JSON.stringify(instruction)).catch(() => undefined);
    reverse.mutate(instruction);
  };

  return (
    <View className="gap-3">
      {pending ? (
        <Admonition type="warning">
          <AdmonitionText>
            {t('connect.reverse.pending', { amount: formatAmount(pending.body.amount, currency) })}
          </AdmonitionText>
        </Admonition>
      ) : (
        <FormField
          label={t('connect.reverse.amount', { currency })}
          value={amount}
          onChange={setAmount}
          keyboardType="decimal-pad"
          invalid={invalid !== null}
          hint={
            invalid
              ? t(REVERSAL_ERRORS[invalid], { decimals: amountDecimals(currency) })
              : t('connect.reverse.help', {
                  amount: formatAmount(reversibleAmount(transfer), currency),
                })
          }
          disabled={reverse.isPending}
        />
      )}
      <View className="flex-row flex-wrap gap-2">
        <Button
          appearance="solid"
          tone="danger"
          size="sm"
          loading={reverse.isPending}
          onPress={submit}
        >
          {pending ? t('connect.reverse.retry') : t('connect.reverse.submit')}
        </Button>
        {pending && !reverse.isPending ? (
          <Button appearance="outline" size="sm" onPress={forget}>
            {t('connect.reverse.discard')}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

/** One settlement: what it paid, to whom, out of which payment — and its reversals. */
export function TransferRow({
  scope,
  transfer,
  showSeller,
}: {
  scope: DashboardScope;
  transfer: Transfer;
  showSeller: boolean;
}) {
  const router = useRouter();
  const { can } = useDashboardPermissions();
  const [open, setOpen] = useState(false);
  const currency = normalizeCurrency(transfer.currency);
  const seller = idOf(transfer.connected_account);
  const payment = idOf(transfer.payment_intent);
  return (
    <View className="gap-2 py-4 border-b border-border">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-row flex-wrap items-center gap-2 flex-1 min-w-64">
          <ToneBadge
            tone={transferStatusTone(transfer.status)}
            label={transferStatusLabel(transfer.status)}
          />
          <Text variant="body-2-semibold">{formatAmount(transfer.amount, currency)}</Text>
          {transfer.amount_reversed !== '0' ? (
            <Text variant="caption-1-regular" className="text-muted-foreground">
              {t('connect.transfer.reversed', {
                amount: formatAmount(transfer.amount_reversed, currency),
              })}
            </Text>
          ) : null}
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {formatInstant(transfer.created)}
          </Text>
        </View>
        <Button appearance="outline" size="sm" onPress={() => setOpen((prior) => !prior)}>
          {open ? t('connect.transfer.hide') : t('connect.transfer.show')}
        </Button>
      </View>
      <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
        <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
          {transfer.id} · {transfer.external_ref}
        </Text>
        <LinkButton
          size="sm"
          accessibilityLabel={`${t('payment.title')} ${payment}`}
          onPress={() => router.push({ pathname: '/payments/[id]', params: { id: payment } })}
        >
          {payment}
        </LinkButton>
        {showSeller ? (
          <LinkButton
            size="sm"
            accessibilityLabel={`${t('connect.seller')} ${seller}`}
            onPress={() => router.push(sellerPath(seller))}
          >
            {seller}
          </LinkButton>
        ) : null}
      </View>
      {transfer.failure_message ? (
        <Text variant="caption-1-regular" selectable className="text-destructive">
          {transfer.failure_message}
        </Text>
      ) : null}
      {open ? (
        <View className="gap-4 rounded-xl border border-border p-4">
          <Text variant="body-2-semibold">{t('connect.reversals')}</Text>
          <Reversals scope={scope} transfer={transfer} />
          {/* Reversing moves money (`billing:manage`); the page's notice says why it is absent. */}
          {canReverse(transfer) && can('money') ? (
            <Reverse scope={scope} transfer={transfer} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
