import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Review } from '@peable.to/shared-types';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { describeError, isOrbitApiError } from '../api/transport';
import { formatAmount } from '../format/money';
import { formatInstant } from '../format/time';
import { labelFor, t } from '../i18n';
import { paymentKeys } from '../payments/usePayments';
import { useDashboardPermissions } from '../scope/useDashboardPermissions';
import { Choice } from '../ui/Choice';
import { PaymentStatusBadge } from '../ui/StatusBadge';
import { PaymentLink, Predicate, ReviewStatusBadge, RuleActionBadge, RuleLink } from './RadarParts';
import {
  type RefusalChoice,
  REVIEW_REFUSAL_REASONS,
  refuseBody,
  reviewActions,
  reviewFailure,
  reviewPayment,
  reviewPaymentId,
} from './reviews';
import { radarKeys } from './useRadar';

const refusalOptions = () => [
  ...REVIEW_REFUSAL_REASONS.map((reason) => ({
    value: reason,
    label: labelFor('review.refusalReason', reason),
  })),
  { value: 'none', label: t('review.refusalReason.none') },
];

/**
 * Approve, or refuse with a reason behind a one-shot confirmation: a refusal
 * releases an uncaptured authorization or refunds a captured payment in full,
 * and cannot be taken back. Both are `money`.
 */
export function ReviewActions({ scope, review }: { scope: DashboardScope; review: Review }) {
  const queryClient = useQueryClient();
  const permitted = useDashboardPermissions().can('money');
  const [reason, setReason] = useState<RefusalChoice>('fraudulent');
  const [confirming, setConfirming] = useState(false);
  const paymentId = reviewPaymentId(review);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: radarKeys.all(scope) });
    void queryClient.invalidateQueries({ queryKey: paymentKeys.detail(scope, paymentId) });
    void queryClient.invalidateQueries({ queryKey: [...paymentKeys.all(scope), 'list'] });
  };
  const fail = (error: unknown) => {
    const known = reviewFailure(error);
    if (known) {
      const requestId = isOrbitApiError(error) ? error.requestId : undefined;
      toast.error(
        requestId
          ? `${t(known.key)} ${t('review.error.request', { id: requestId })}`
          : t(known.key),
      );
      if (known.refresh) refresh();
      return;
    }
    toast.error(describeError(error, t('error.generic')));
  };

  const approve = useMutation({
    mutationFn: () => dashboardApi.reviews.approve(scope, review.id),
    onSuccess: () => {
      toast.success(t('review.approved'));
      refresh();
    },
    onError: fail,
  });
  const refuse = useMutation({
    mutationFn: (choice: RefusalChoice) =>
      dashboardApi.reviews.refuse(scope, review.id, refuseBody(choice)),
    onSuccess: () => {
      toast.success(t('review.refused'));
      refresh();
    },
    onError: fail,
  });

  if (!reviewActions(review).length || !permitted) return null;
  const busy = approve.isPending || refuse.isPending;

  return (
    <View className="flex-row flex-wrap items-end gap-2">
      <View className="w-60">
        <Choice
          size="sm"
          label={t('review.refusalReason')}
          value={reason}
          options={refusalOptions()}
          onChange={(value) => setReason(value as RefusalChoice)}
          disabled={busy}
        />
      </View>
      <Button
        appearance="outline"
        tone="danger"
        size="sm"
        loading={refuse.isPending}
        disabled={busy}
        onPress={() => setConfirming(true)}
      >
        {t('review.refuse')}
      </Button>
      <Button
        appearance="solid"
        tone="accent"
        size="sm"
        loading={approve.isPending}
        disabled={busy}
        onPress={() => approve.mutate()}
      >
        {t('review.approve')}
      </Button>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title={t('review.confirmRefuse.title')}
        description={t('review.confirmRefuse.body', {
          reason:
            reason === 'none'
              ? t('review.refusalReason.none')
              : labelFor('review.refusalReason', reason),
        })}
        confirmLabel={t('review.confirmRefuse.action')}
        cancelLabel={t('action.cancel')}
        destructive
        defaultAction="cancel"
        onConfirm={() => {
          setConfirming(false);
          refuse.mutate(reason);
        }}
        onCancel={() => setConfirming(false)}
      />
    </View>
  );
}

/** One review in the queue: the payment it holds, the rule that opened it, why, when, and its actions. */
export function ReviewCard({ scope, review }: { scope: DashboardScope; review: Review }) {
  const router = useRouter();
  const payment = reviewPayment(review);
  return (
    <View className="gap-2 py-4 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <ReviewStatusBadge review={review} />
        {payment ? (
          <Text variant="body-2-semibold" style={{ fontVariant: ['tabular-nums'] }}>
            {formatAmount(payment.amount, payment.currency)}
          </Text>
        ) : null}
        {payment ? <PaymentStatusBadge status={payment.status} /> : null}
        <PaymentLink id={reviewPaymentId(review)} />
      </View>
      {review.rule ? (
        <View className="gap-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <RuleActionBadge action={review.rule.action} />
            <RuleLink id={review.rule.id} version={review.rule.version} />
          </View>
          <Predicate text={review.rule.predicate} lines={3} />
        </View>
      ) : null}
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {review.open
          ? t('review.openedAt', {
              reason: labelFor('review.openedReason', review.opened_reason),
              at: formatInstant(review.created),
            })
          : t('review.closedAt', {
              reason: review.closed_reason
                ? labelFor('review.closedReason', review.closed_reason)
                : t('review.status.closed'),
              at: formatInstant(review.closed_at),
            })}
      </Text>
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <LinkButton
          size="sm"
          accessibilityLabel={`${t('review.title')} ${review.id}`}
          onPress={() => router.push({ pathname: '/reviews/[id]', params: { id: review.id } })}
        >
          {review.id}
        </LinkButton>
        <ReviewActions scope={scope} review={review} />
      </View>
    </View>
  );
}
