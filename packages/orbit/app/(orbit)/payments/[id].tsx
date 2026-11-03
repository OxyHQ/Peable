import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { PaymentIntent } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatAmount } from '@/format/money';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { paymentTimeline, type TimelineStep } from '@/payments/timeline';
import { usePayment } from '@/payments/usePayments';
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

function PaymentDetail({ payment }: { payment: PaymentIntent }) {
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
            {payment.network ? (
              <Field label={t('payment.field.network')} value={payment.network} />
            ) : null}
            {payment.address ? (
              <Field label={t('payment.field.address')} value={payment.address} mono />
            ) : null}
            {payment.txid ? (
              <Field label={t('payment.field.txid')} value={payment.txid} mono />
            ) : null}
            {payment.rail === 'faircoin' ? (
              <Field label={t('payment.field.confirmations')} value={payment.confirmations} />
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
  return <PaymentDetail payment={query.data} />;
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
