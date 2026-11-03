import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Invoice } from '@peable.to/shared-types';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatSignedAmount } from '@/billing/amount';
import { ExternalLink, InvoiceStatusBadge, refId } from '@/billing/BillingParts';
import { invoiceActions, type InvoiceAction } from '@/billing/status';
import { billingKeys, useInvoice } from '@/billing/useBilling';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import {
  DetailHeader,
  DetailLayout,
  ErrorNotice,
  Field,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';
import { ActionPermissionNotice } from '@/ui/ActionPermissionNotice';
import { Timestamp } from '@/ui/data';
import { isNotFound, NotFound, PageSkeleton } from '@/ui/states';

const fail = (error: unknown) => toast.error(describeError(error, t('error.generic')));

function Actions({ scope, invoice }: { scope: DashboardScope; invoice: Invoice }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const act = useMutation({
    mutationFn: (action: InvoiceAction) => dashboardApi.invoices.act(scope, invoice.id, action),
    onSuccess: (_updated, action) => {
      toast.success(t(`invoice.done.${action}`));
      void queryClient.invalidateQueries({ queryKey: billingKeys.all(scope) });
    },
    onError: fail,
  });
  const actions = invoiceActions(invoice);
  return (
    <View className="gap-2">
      {actions.length ? <ActionPermissionNotice action="money" /> : null}
      <View className="flex-row flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            appearance={action === 'finalize' ? 'solid' : 'outline'}
            tone={action === 'finalize' ? 'accent' : action === 'void' ? 'danger' : undefined}
            size="sm"
            loading={act.isPending && act.variables === action}
            disabled={!can('money')}
            onPress={() => act.mutate(action)}
          >
            {t(`invoice.action.${action}`)}
          </Button>
        ))}
        <ExternalLink url={invoice.hosted_invoice_url} label={t('invoice.hostedPage')} />
        <ExternalLink url={invoice.invoice_pdf} label={t('invoice.pdf')} />
      </View>
    </View>
  );
}

function money(invoice: Invoice, amount: string | null): string {
  return amount === null ? t('invoice.taxPending') : formatSignedAmount(amount, invoice.currency);
}

function InvoiceDetail({ scope, invoice }: { scope: DashboardScope; invoice: Invoice }) {
  const router = useRouter();
  const customerId = refId(invoice.customer as string | { id: string });
  const subscriptionId = refId(invoice.subscription as string | { id: string } | null);
  const transitions = invoice.status_transitions;
  return (
    <View className="gap-6">
      <DetailHeader
        headline={formatSignedAmount(invoice.total, invoice.currency)}
        status={<InvoiceStatusBadge status={invoice.status} />}
        id={invoice.id}
        facts={[
          { label: t('list.column.number'), value: invoice.number ?? t('invoice.draftNumber') },
          { label: t('list.column.created'), value: <Timestamp seconds={invoice.created} /> },
          ...(invoice.due_date
            ? [{ label: t('list.column.due'), value: <Timestamp seconds={invoice.due_date} /> }]
            : []),
        ]}
      />
      <Actions scope={scope} invoice={invoice} />
      {invoice.last_finalization_error ? (
        <Text variant="body-2-regular" className="text-destructive">
          {invoice.last_finalization_error.message}
        </Text>
      ) : null}
      <DetailLayout
        aside={
          <Section title={t('invoice.details')}>
            <Field label={t('invoice.field.id')} value={invoice.id} mono />
            <Field
              label={t('invoice.field.customer')}
              value={
                customerId ? (
                  <LinkButton
                    size="sm"
                    onPress={() =>
                      router.push({ pathname: '/customers/[id]', params: { id: customerId } })
                    }
                  >
                    {invoice.customer_name ?? invoice.customer_email ?? customerId}
                  </LinkButton>
                ) : (
                  '—'
                )
              }
            />
            {subscriptionId ? (
              <Field
                label={t('invoice.field.subscription')}
                value={
                  <LinkButton
                    size="sm"
                    onPress={() =>
                      router.push({
                        pathname: '/subscriptions/[id]',
                        params: { id: subscriptionId },
                      })
                    }
                  >
                    {subscriptionId}
                  </LinkButton>
                }
              />
            ) : null}
            <Field
              label={t('invoice.field.reason')}
              value={t(`invoice.reason.${invoice.billing_reason}`)}
            />
            <Field
              label={t('subscription.field.collection')}
              value={t(`collection.${invoice.collection_method}`)}
            />
            <Field
              label={t('invoice.field.period')}
              value={`${formatInstant(invoice.period_start)} → ${formatInstant(invoice.period_end)}`}
            />
            {invoice.due_date ? (
              <Field label={t('invoice.field.due')} value={formatInstant(invoice.due_date)} />
            ) : null}
            <Field label={t('invoice.field.attempts')} value={String(invoice.attempt_count)} />
            {invoice.next_payment_attempt ? (
              <Field
                label={t('invoice.field.nextAttempt')}
                value={formatInstant(invoice.next_payment_attempt)}
              />
            ) : null}
            <Field
              label={t('invoice.field.tax')}
              value={
                invoice.automatic_tax.enabled
                  ? t('invoice.automaticTax', {
                      status: invoice.automatic_tax.status ?? t('invoice.taxPending'),
                    })
                  : t('invoice.noAutomaticTax')
              }
            />
          </Section>
        }
      >
        <Section title={t('invoice.lines')}>
          {invoice.lines.data.map((line) => (
            <View
              key={line.id}
              className="flex-row flex-wrap justify-between gap-x-4 gap-y-1 py-2 border-b border-border"
            >
              <View className="flex-1 min-w-48 gap-1">
                <Text variant="body-2-regular">{line.description ?? line.id}</Text>
                <Text variant="caption-1-regular" className="text-muted-foreground">
                  {`${formatInstant(line.period.start)} → ${formatInstant(line.period.end)}`}
                  {line.proration ? ` · ${t('invoice.proration')}` : ''}
                </Text>
              </View>
              <Text variant="body-2-semibold" selectable>
                {formatSignedAmount(line.amount, line.currency)}
              </Text>
            </View>
          ))}
          <Field label={t('invoice.subtotal')} value={money(invoice, invoice.subtotal)} />
          {invoice.total_discount_amounts.length ? (
            <Field
              label={t('invoice.discount')}
              value={invoice.total_discount_amounts
                .map((entry) => formatSignedAmount(entry.amount, invoice.currency))
                .join(', ')}
            />
          ) : null}
          <Field label={t('invoice.tax')} value={money(invoice, invoice.tax)} />
          <Field label={t('invoice.total')} value={money(invoice, invoice.total)} />
          <Field
            label={t('invoice.startingBalance')}
            value={money(invoice, invoice.starting_balance)}
          />
          <Field label={t('invoice.amountDue')} value={money(invoice, invoice.amount_due)} />
          <Field label={t('invoice.amountPaid')} value={money(invoice, invoice.amount_paid)} />
          <Field
            label={t('invoice.amountRemaining')}
            value={money(invoice, invoice.amount_remaining)}
          />
        </Section>
        <Section title={t('invoice.timeline')}>
          <Field label={t('invoice.created')} value={formatInstant(invoice.created)} />
          <Field label={t('invoice.finalized')} value={formatInstant(transitions.finalized_at)} />
          <Field label={t('invoice.paid')} value={formatInstant(transitions.paid_at)} />
          <Field label={t('invoice.voided')} value={formatInstant(transitions.voided_at)} />
          <Field
            label={t('invoice.uncollectible')}
            value={formatInstant(transitions.marked_uncollectible_at)}
          />
        </Section>
      </DetailLayout>
    </View>
  );
}

function InvoiceLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useInvoice(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('invoice.title')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('invoice.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <InvoiceDetail scope={scope} invoice={query.data} />;
}

export default function InvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('invoice.title')}>
      {({ scope }) => (id ? <InvoiceLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
