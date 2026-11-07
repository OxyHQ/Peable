import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaymentIntent, TerminalReader } from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatAmount } from '@/format/money';
import { t } from '@/i18n';
import { paymentKeys } from '@/payments/usePayments';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { CollectPayment } from '@/terminal/CollectPayment';
import { locationName, ReaderStatusBadge, terminalErrorMessage } from '@/terminal/TerminalParts';
import {
  actionPaymentIntent,
  type CollectionOutcome,
  collectionOutcome,
  defaultCurrencyFor,
  isCollecting,
  isTestMode,
  outcomeTone,
  parseLabel,
  readerLocationId,
} from '@/terminal/terminalForm';
import {
  terminalKeys,
  useCollectedPayment,
  useLocationOptions,
  useReader,
} from '@/terminal/useTerminal';
import { Timestamp } from '@/ui/data';
import { FormField } from '@/ui/FormField';
import {
  DetailHeader,
  DetailLayout,
  ErrorNotice,
  Field,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';
import { isNotFound, NotFound, PageSkeleton, PermissionNotice } from '@/ui/states';

const ADMONITION_TYPE = {
  success: 'tip',
  danger: 'error',
  warning: 'warning',
  info: 'info',
  neutral: 'info',
} as const;

function outcomeText(outcome: CollectionOutcome, intent: PaymentIntent | undefined) {
  const amount = intent ? formatAmount(intent.amount, intent.currency) : '';
  switch (outcome.kind) {
    case 'none':
      return null;
    case 'collecting':
      return {
        title: t('collect.outcome.collecting.title'),
        body: intent
          ? t('collect.outcome.collecting.body', { amount })
          : t('collect.outcome.collectingNoAmount'),
      };
    case 'declined':
      return {
        title: t('collect.outcome.declined.title'),
        body: t('collect.outcome.declined.body', {
          message: outcome.message ?? t('collect.outcome.declinedFallback'),
        }),
      };
    case 'failed':
      return {
        title: t('collect.outcome.failed.title'),
        body: t('collect.outcome.failed.body', {
          message: outcome.message ?? t('collect.outcome.unknownFailure'),
        }),
      };
    case 'succeeded':
    case 'authorized':
      return {
        title: t(`collect.outcome.${outcome.kind}.title`),
        body: t(`collect.outcome.${outcome.kind}.body`, { amount }),
      };
    case 'settling':
    case 'stopped':
    case 'canceled':
      return {
        title: t(`collect.outcome.${outcome.kind}.title`),
        body: t(`collect.outcome.${outcome.kind}.body`),
      };
  }
}

/** The reader's current or last collection: where it stands, and what can be done about it. */
function Collection({ scope, reader }: { scope: DashboardScope; reader: TerminalReader }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const [open, setOpen] = useState(false);
  const locations = useLocationOptions(scope);
  const paymentId = actionPaymentIntent(reader);
  const payment = useCollectedPayment(
    scope,
    paymentId,
    (intent) => collectionOutcome(reader, intent).kind === 'settling',
  );
  const outcome = collectionOutcome(reader, payment.data);
  const collecting = isCollecting(reader);
  const allowed = can('money');
  const test = isTestMode(scope.environment);

  // The reader finished: read its payment again rather than trust the copy from before.
  const lastStatus = useRef(reader.action?.status);
  useEffect(() => {
    const status = reader.action?.status;
    if (lastStatus.current === 'in_progress' && status !== 'in_progress' && paymentId) {
      void queryClient.invalidateQueries({ queryKey: paymentKeys.detail(scope, paymentId) });
    }
    lastStatus.current = status;
  }, [reader.action?.status, paymentId, queryClient, scope]);

  const readerKey = terminalKeys.reader(scope, reader.id);
  const cancel = useMutation({
    mutationFn: () => dashboardApi.terminal.readers.cancelAction(scope, reader.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(readerKey, updated);
      toast.success(t('collect.cancelled'));
    },
    onError: (error) => {
      toast.error(t('collect.cancelFailed', { reason: terminalErrorMessage(error) }));
      void queryClient.invalidateQueries({ queryKey: readerKey });
    },
  });
  const simulate = useMutation({
    mutationFn: () => dashboardApi.terminal.readers.presentPaymentMethod(scope, reader.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(readerKey, updated);
      toast.success(t('collect.simulated'));
    },
    onError: (error) => {
      toast.error(t('collect.simulateFailed', { reason: terminalErrorMessage(error) }));
      void queryClient.invalidateQueries({ queryKey: readerKey });
    },
  });

  const text = outcomeText(outcome, payment.data);
  const locationId = readerLocationId(reader);
  const country =
    locations.data?.find((location) => location.id === locationId)?.address.country ?? null;

  return (
    <Section title={t('collect.title')}>
      {text ? (
        <Admonition type={ADMONITION_TYPE[outcomeTone(outcome)]}>
          <View className="gap-2">
            <Text variant="body-2-semibold">{text.title}</Text>
            <AdmonitionText>{text.body}</AdmonitionText>
            {payment.isError ? (
              <AdmonitionText>
                {t('collect.outcome.paymentFailed', {
                  reason: describeError(payment.error, t('error.generic')),
                })}
              </AdmonitionText>
            ) : null}
            <View className="flex-row flex-wrap items-center gap-2">
              {collecting && test ? (
                <Button
                  appearance="solid"
                  tone="accent"
                  size="sm"
                  loading={simulate.isPending}
                  disabled={!allowed || cancel.isPending}
                  onPress={() => simulate.mutate()}
                >
                  {t('collect.simulate')}
                </Button>
              ) : null}
              {collecting ? (
                <Button
                  appearance="outline"
                  tone="danger"
                  size="sm"
                  loading={cancel.isPending}
                  disabled={!allowed || simulate.isPending}
                  onPress={() => cancel.mutate()}
                >
                  {t('collect.cancel')}
                </Button>
              ) : null}
              {paymentId ? (
                <Button
                  appearance="plain"
                  size="sm"
                  onPress={() =>
                    router.push({ pathname: '/payments/[id]', params: { id: paymentId } })
                  }
                >
                  {t('collect.openPayment')}
                </Button>
              ) : null}
            </View>
          </View>
        </Admonition>
      ) : null}
      <PermissionNotice action="money" />
      {open && !collecting ? (
        <CollectPayment
          scope={scope}
          readerId={reader.id}
          defaultCurrency={defaultCurrencyFor(country)}
          onClose={() => setOpen(false)}
          onStarted={(result) => {
            setOpen(false);
            queryClient.setQueryData(readerKey, result.reader);
            queryClient.setQueryData(
              paymentKeys.detail(scope, result.payment_intent.id),
              result.payment_intent,
            );
            void queryClient.invalidateQueries({ queryKey: terminalKeys.readers(scope) });
          }}
        />
      ) : null}
      {!open && !collecting ? (
        <View className="flex-row">
          <Button
            appearance="solid"
            tone="accent"
            disabled={!allowed}
            onPress={() => setOpen(true)}
          >
            {outcome.kind === 'none' ? t('collect.open') : t('collect.again')}
          </Button>
        </View>
      ) : null}
    </Section>
  );
}

/** The reader's label, and deleting it. */
function Manage({ scope, reader }: { scope: DashboardScope; reader: TerminalReader }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const allowed = can('money');
  const [label, setLabel] = useState(reader.label);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const readerKey = terminalKeys.reader(scope, reader.id);

  const relabel = useMutation({
    mutationFn: (next: string) =>
      dashboardApi.terminal.readers.update(scope, reader.id, { label: next }),
    onSuccess: (updated) => {
      setLabelError(null);
      queryClient.setQueryData(readerKey, updated);
      void queryClient.invalidateQueries({ queryKey: terminalKeys.readers(scope) });
      toast.success(t('reader.label.saved'));
    },
    onError: (error) =>
      setLabelError(t('reader.label.failed', { reason: terminalErrorMessage(error) })),
  });
  const remove = useMutation({
    mutationFn: () => dashboardApi.terminal.readers.delete(scope, reader.id),
    onSuccess: () => {
      toast.success(t('reader.deleted'));
      void queryClient.invalidateQueries({ queryKey: terminalKeys.all(scope) });
      router.replace('/terminal');
    },
    onError: (error) => {
      toast.error(t('reader.deleteFailed', { reason: terminalErrorMessage(error) }));
      void queryClient.invalidateQueries({ queryKey: readerKey });
    },
  });

  const saveLabel = () => {
    const next = parseLabel(label);
    if (next === null) {
      setLabelError(t('reader.label.error'));
      return;
    }
    relabel.mutate(next);
  };

  return (
    <View className="gap-3">
      <FormField
        label={t('reader.label')}
        value={label}
        onChange={setLabel}
        autoCapitalize="sentences"
        invalid={labelError !== null}
        {...(labelError ? { hint: labelError } : {})}
        disabled={!allowed || relabel.isPending}
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          appearance="outline"
          size="sm"
          loading={relabel.isPending}
          disabled={!allowed || label.trim() === reader.label}
          onPress={saveLabel}
        >
          {t('reader.label.save')}
        </Button>
        <Button
          appearance="outline"
          tone="danger"
          size="sm"
          loading={remove.isPending}
          disabled={!allowed || isCollecting(reader)}
          onPress={() => setConfirming(true)}
        >
          {t('reader.delete')}
        </Button>
      </View>
      {isCollecting(reader) ? (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('terminal.readerBusy')}
        </Text>
      ) : null}
      <AlertDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('reader.confirmDelete.title')}
        description={t('reader.confirmDelete.body')}
        confirmLabel={t('reader.confirmDelete.action')}
        cancelLabel={t('reader.confirm.keep')}
        destructive
        onConfirm={() => {
          setConfirming(false);
          remove.mutate();
        }}
      />
    </View>
  );
}

function ReaderDetail({ scope, reader }: { scope: DashboardScope; reader: TerminalReader }) {
  const locations = useLocationOptions(scope);
  const names = new Map(
    (locations.data ?? []).map((location) => [location.id, location.display_name]),
  );
  const where = locationName(reader, names);
  const simulated = isTestMode(scope.environment) && reader.device_type.startsWith('simulated');
  return (
    <View className="gap-6">
      <DetailHeader
        headline={reader.label}
        status={<ReaderStatusBadge status={reader.status} />}
        id={reader.id}
        facts={[
          { label: t('reader.field.deviceType'), value: reader.device_type },
          { label: t('reader.field.location'), value: where },
          {
            label: t('reader.field.lastSeen'),
            value: <Timestamp seconds={reader.last_seen_at} />,
          },
        ]}
      />
      {simulated ? (
        <Admonition type="info">
          <AdmonitionText>{t('reader.simulatedNote')}</AdmonitionText>
        </Admonition>
      ) : null}
      <DetailLayout
        aside={
          <Section title={t('reader.details')}>
            <Field label={t('reader.field.id')} value={reader.id} mono />
            <Field label={t('reader.field.deviceType')} value={reader.device_type} mono />
            <Field label={t('reader.field.serial')} value={reader.serial_number} mono />
            <Field label={t('reader.field.location')} value={where} />
            <Field
              label={t('reader.field.status')}
              value={<ReaderStatusBadge status={reader.status} />}
            />
            <Manage key={reader.label} scope={scope} reader={reader} />
          </Section>
        }
      >
        <Collection scope={scope} reader={reader} />
      </DetailLayout>
    </View>
  );
}

function ReaderLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useReader(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('reader.title')} />;
  if (query.isError) {
    // A 404 for this object: it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('reader.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <ReaderDetail scope={scope} reader={query.data} />;
}

export default function ReaderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('reader.title')}>
      {({ scope }) => (id ? <ReaderLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
