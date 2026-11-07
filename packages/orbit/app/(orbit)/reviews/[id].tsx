import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { Review } from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import type { DashboardScope } from '@/api/dashboard';
import { formatAmount } from '@/format/money';
import { formatInstant } from '@/format/time';
import { labelFor, t } from '@/i18n';
import {
  PaymentLink,
  PaymentRisk,
  Predicate,
  ReviewStatusBadge,
  RuleActionBadge,
  RuleLink,
} from '@/radar/RadarParts';
import { ReviewActions } from '@/radar/ReviewParts';
import { reviewPayment, reviewPaymentId } from '@/radar/reviews';
import { useReview } from '@/radar/useRadar';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import {
  DetailHeader,
  DetailLayout,
  ErrorNotice,
  Field,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';
import { isNotFound, NotFound, PageSkeleton, PermissionNotice } from '@/ui/states';
import { PaymentStatusBadge } from '@/ui/StatusBadge';

function ReviewFacts({ review }: { review: Review }) {
  const payment = reviewPayment(review);
  const chargeId =
    review.charge === null
      ? null
      : typeof review.charge === 'string'
        ? review.charge
        : review.charge.id;
  return (
    <Section title={t('review.details')}>
      <Field label={t('review.field.id')} value={review.id} mono />
      <Field
        label={t('review.field.payment')}
        value={<PaymentLink id={reviewPaymentId(review)} />}
      />
      {payment ? (
        <Field
          label={t('review.field.paymentStatus')}
          value={<PaymentStatusBadge status={payment.status} />}
        />
      ) : null}
      {chargeId ? <Field label={t('review.field.charge')} value={chargeId} mono /> : null}
      <Field
        label={t('review.field.opened')}
        value={labelFor('review.openedReason', review.opened_reason)}
      />
      <Field label={t('review.field.created')} value={formatInstant(review.created)} />
      {!review.open ? (
        <>
          <Field
            label={t('review.field.closedReason')}
            value={
              review.closed_reason
                ? labelFor('review.closedReason', review.closed_reason)
                : t('review.status.closed')
            }
          />
          <Field label={t('review.field.closed')} value={formatInstant(review.closed_at)} />
        </>
      ) : null}
      <Field
        label={t('payment.field.mode')}
        value={review.livemode ? t('scope.live') : t('scope.test')}
      />
    </Section>
  );
}

function ReviewDetail({ scope, review }: { scope: DashboardScope; review: Review }) {
  const { can } = useDashboardPermissions();
  const payment = reviewPayment(review);
  return (
    <View className="gap-6">
      <DetailHeader
        headline={payment ? formatAmount(payment.amount, payment.currency) : review.id}
        status={<ReviewStatusBadge review={review} />}
        id={review.id}
      />
      <DetailLayout aside={<ReviewFacts review={review} />}>
        {review.open ? (
          <Section title={t('review.decide')} description={t('review.decideBody')}>
            {can('money') ? (
              <>
                <Admonition type="warning">
                  <AdmonitionText>{t('review.refuseWarning')}</AdmonitionText>
                </Admonition>
                <ReviewActions scope={scope} review={review} />
              </>
            ) : (
              <PermissionNotice action="money" />
            )}
          </Section>
        ) : null}
        {review.rule ? (
          <Section title={t('review.rule')} description={t('review.ruleBody')}>
            <View className="flex-row flex-wrap items-center gap-2">
              <RuleActionBadge action={review.rule.action} />
              <RuleLink id={review.rule.id} version={review.rule.version} />
            </View>
            <Predicate text={review.rule.predicate} />
          </Section>
        ) : null}
        {payment ? <PaymentRisk scope={scope} payment={payment} /> : null}
      </DetailLayout>
    </View>
  );
}

function ReviewLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useReview(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('review.title')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('review.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <ReviewDetail scope={scope} review={query.data} />;
}

export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('review.title')}>
      {({ scope }) => (id ? <ReviewLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
