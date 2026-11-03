import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { PaymentIntent } from '@peable.to/shared-types';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { dashboardApi } from '@/api/client';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { eventPath, requestLogPath } from '@/developers/requestLogs';
import { formatAmount } from '@/format/money';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { cancellationReasonLabel } from '@/payments/status';
import { paymentTimeline, type TimelineStep } from '@/payments/timeline';
import { paymentKeys, usePayment } from '@/payments/usePayments';
import { ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { PaymentStatusBadge } from '@/ui/StatusBadge';

const DOT: Record<TimelineStep['state'], string> = {
  done: 'bg-primary',
  current: 'bg-primary border-4 border-primary-subtle',
  upcoming: 'bg-muted',
  failed: 'bg-destructive',
};

function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <View>
      {steps.map((step, index) => (
        <View key={step.key} className="flex-row gap-3">
          <View className="items-center w-4">
            <View className={`w-3 h-3 rounded-full mt-1.5 ${DOT[step.state]}`} />
            {index < steps.length - 1 ? <View className="w-px flex-1 bg-border" /> : null}
          </View>
          <View className="flex-1 pb-4 gap-0.5">
            <Text
              variant="body-2-semibold"
              className={step.state === 'upcoming' ? 'text-muted-foreground' : undefined}
            >
              {step.label}
            </Text>
            {step.at !== undefined ? (
              <Text variant="caption-1-regular" className="text-muted-foreground">
                {formatInstant(step.at)}
              </Text>
            ) : null}
            {step.detail ? (
              <Text variant="caption-1-regular" selectable className="text-muted-foreground">
                {step.detail}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * What happened to this payment, as its events recorded it (the last 30 days),
 * each linked to the API request that caused it when one did — the step from a
 * payment to the exact call that moved it.
 */
function PaymentEvents({ scope, payment }: { scope: DashboardScope; payment: PaymentIntent }) {
  const router = useRouter();
  const query = useQuery({
    queryKey: [...paymentKeys.detail(scope, payment.id), 'events'],
    queryFn: () => dashboardApi.events.list(scope, { payment_intent: payment.id, limit: 100 }),
  });
  let body: React.ReactNode;
  if (query.isPending) body = <Loading accessibilityLabel={t('payment.events')} />;
  else if (query.isError) {
    body = <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  } else if (!query.data.data.length) {
    body = (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('payment.events.none')}
      </Text>
    );
  } else {
    body = query.data.data.map((event) => (
      <View
        key={event.id}
        className="flex-row flex-wrap items-center gap-x-3 gap-y-1 py-2 border-b border-border"
      >
        <LinkButton
          size="sm"
          accessibilityLabel={`${t('developers.event')} ${event.id}`}
          onPress={() => router.push(eventPath(event.id))}
        >
          {event.type}
        </LinkButton>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {formatInstant(event.created)}
        </Text>
        {event.request.id ? (
          <LinkButton
            size="sm"
            accessibilityLabel={t('developers.event.request', { id: event.request.id })}
            onPress={() => router.push(requestLogPath(event.request.id ?? ''))}
          >
            {t('developers.event.request', { id: event.request.id })}
          </LinkButton>
        ) : (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('payment.events.noRequest')}
          </Text>
        )}
      </View>
    ));
  }
  return (
    <Section title={t('payment.events')} description={t('payment.eventsNote')}>
      {body}
    </Section>
  );
}

/** A reference as its id, whether or not the read expanded it. */
function idOf(reference: string | { id: string }): string {
  return typeof reference === 'string' ? reference : reference.id;
}

function PaymentDetail({ scope, payment }: { scope: DashboardScope; payment: PaymentIntent }) {
  const metadata = Object.entries(payment.metadata ?? {});
  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap items-center gap-3">
        <Text variant="title-1-bold" selectable>
          {formatAmount(payment.amount, payment.currency)}
        </Text>
        <PaymentStatusBadge status={payment.status} />
      </View>
      <View className="flex-row flex-wrap gap-6">
        <View className="flex-1 min-w-80">
          <Section title={t('payment.details')}>
            <Field label={t('payment.field.id')} value={payment.id} mono />
            <Field
              label={t('payment.field.amount')}
              value={formatAmount(payment.amount, payment.currency)}
            />
            <Field label={t('payment.field.baseUnits')} value={payment.amount} mono />
            <Field label={t('payment.field.rail')} value={t(`payments.rail.${payment.rail}`)} />
            {payment.amount_received !== '0' ? (
              <Field
                label={t('payment.field.received')}
                value={formatAmount(payment.amount_received, payment.currency)}
              />
            ) : null}
            {payment.amount_capturable !== '0' ? (
              <Field
                label={t('payment.field.capturable')}
                value={formatAmount(payment.amount_capturable, payment.currency)}
              />
            ) : null}
            {payment.amount_refunded !== '0' ? (
              <Field
                label={t('payment.field.refunded')}
                value={formatAmount(payment.amount_refunded, payment.currency)}
              />
            ) : null}
            {payment.capture_method === 'manual' ? (
              <Field
                label={t('payment.field.captureMethod')}
                value={t('payment.field.captureManual')}
              />
            ) : null}
            {payment.status === 'canceled' ? (
              <Field
                label={t('payment.field.canceledReason')}
                value={cancellationReasonLabel(payment.cancellation_reason)}
              />
            ) : null}
            {payment.last_payment_error ? (
              <Field
                label={t('payment.field.lastError')}
                value={payment.last_payment_error.message}
              />
            ) : null}
            {payment.faircoin ? (
              <>
                <Field label={t('payment.field.network')} value={payment.faircoin.network} />
                <Field label={t('payment.field.address')} value={payment.faircoin.address} mono />
                {payment.faircoin.txid ? (
                  <Field label={t('payment.field.txid')} value={payment.faircoin.txid} mono />
                ) : null}
                <Field
                  label={t('payment.field.confirmations')}
                  value={t('payment.field.confirmationsValue', {
                    count: payment.faircoin.confirmations,
                    required: payment.faircoin.required_confirmations,
                  })}
                />
              </>
            ) : null}
            {payment.customer ? (
              <Field label={t('payment.field.customer')} value={idOf(payment.customer)} mono />
            ) : null}
            {payment.payment_method ? (
              <Field
                label={t('payment.field.paymentMethod')}
                value={idOf(payment.payment_method)}
                mono
              />
            ) : null}
            {payment.latest_charge ? (
              <Field label={t('payment.field.charge')} value={idOf(payment.latest_charge)} mono />
            ) : null}
            {payment.description ? (
              <Field label={t('payment.field.description')} value={payment.description} />
            ) : null}
            {payment.receipt_email ? (
              <Field label={t('payment.field.receiptEmail')} value={payment.receipt_email} />
            ) : null}
            {payment.connected_account ? (
              <Field
                label={t('payment.field.connectedAccount')}
                value={
                  // A `ca_…`, or the account itself when the read was expanded.
                  typeof payment.connected_account === 'string'
                    ? payment.connected_account
                    : payment.connected_account.id
                }
                mono
              />
            ) : null}
            <Field
              label={t('payment.field.mode')}
              value={payment.livemode ? t('scope.live') : t('scope.test')}
            />
            <Field label={t('payment.field.created')} value={formatInstant(payment.created)} />
            <Field label={t('payment.field.updated')} value={formatInstant(payment.updated_at)} />
            {payment.can_expire !== false ? (
              <Field label={t('payment.field.expires')} value={formatInstant(payment.expires_at)} />
            ) : null}
          </Section>
        </View>
        <View className="flex-1 min-w-72">
          <Section title={t('payment.timeline')} description={t('payment.timelineNote')}>
            <Timeline steps={paymentTimeline(payment)} />
          </Section>
        </View>
      </View>
      <PaymentEvents scope={scope} payment={payment} />
      <Section title={t('payment.metadata')}>
        {metadata.length ? (
          metadata.map(([key, value]) => <Field key={key} label={key} value={value} mono />)
        ) : (
          <Text variant="body-2-regular" className="text-muted-foreground">
            {t('payment.noMetadata')}
          </Text>
        )}
      </Section>
    </View>
  );
}

function PaymentLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = usePayment(scope, id);
  if (query.isPending) return <Loading accessibilityLabel={t('payment.title')} />;
  if (query.isError) {
    // 404 means no payment with this id for this merchant in this mode, or no
    // merchant in this mode at all; the gateway's own message says which.
    if (isMerchantMissing(query.error)) {
      return (
        <EmptyState
          title={t('payment.notFound')}
          description={describeError(query.error, t('payment.notFound'))}
        />
      );
    }
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <PaymentDetail scope={scope} payment={query.data} />;
}

export default function PaymentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return (
    <OrbitScreen
      title={t('payment.title')}
      actions={
        <Button
          appearance="plain"
          size="sm"
          leadingIcon={RiArrowLeftLine}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/payments'))}
        >
          {t('nav.payments')}
        </Button>
      }
    >
      {({ scope }) => (id ? <PaymentLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
