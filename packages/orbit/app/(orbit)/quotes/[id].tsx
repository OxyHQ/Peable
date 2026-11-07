import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CheckoutLineItem, Price, Quote } from '@peable.to/shared-types';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope, QuoteAction } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatSignedAmount } from '@/billing/amount';
import { refId } from '@/billing/BillingParts';
import { billingKeys } from '@/billing/useBilling';
import { formatPriceLabel } from '@/catalog/productForm';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { QuoteStatusBadge } from '@/quotes/QuoteParts';
import { quoteActions, quotePdfFilename } from '@/quotes/quoteForm';
import { useQuote } from '@/quotes/useQuotes';
import { saveBlob } from '@/reports/useReports';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Timestamp } from '@/ui/data';
import {
  DetailHeader,
  DetailLayout,
  ErrorNotice,
  Field,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';
import { isNotFound, NotFound, PageSkeleton, PermissionNotice } from '@/ui/states';

const CONFIRMED: readonly QuoteAction[] = ['accept', 'cancel'];

function Actions({ scope, quote }: { scope: DashboardScope; quote: Quote }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const [confirming, setConfirming] = useState<QuoteAction | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: billingKeys.all(scope) });
  const act = useMutation({
    mutationFn: (action: QuoteAction) => dashboardApi.quotes.act(scope, quote.id, action),
    onSuccess: (_updated, action) => {
      setConfirming(null);
      toast.success(t(`quote.done.${action}`));
      refresh();
    },
    onError: (error, action) => {
      setConfirming(null);
      const reason = describeError(error, t('error.generic'));
      // A finalize that fails (tax fails closed) leaves the quote a draft, and says so.
      toast.error(action === 'finalize' ? t('quote.finalizeFailed', { reason }) : reason);
      refresh();
    },
  });
  const pdf = useMutation({
    mutationFn: async () => {
      const blob = await dashboardApi.quotes.pdf(scope, quote.id);
      return saveBlob(blob, quotePdfFilename(quote));
    },
    onSuccess: (saved) =>
      saved ? toast.success(t('quote.pdfSaved')) : toast.error(t('quote.pdfUnsupported')),
    onError: (error) =>
      toast.error(t('quote.pdfFailed', { reason: describeError(error, t('error.generic')) })),
  });
  const actions = quoteActions(quote);
  const allowed = can('money');
  return (
    <View className="gap-3">
      {actions.length ? <PermissionNotice action="money" /> : null}
      <View className="flex-row flex-wrap gap-2">
        {actions.map((action) =>
          action === 'edit' ? (
            <Button
              key={action}
              appearance="outline"
              size="sm"
              disabled={!allowed}
              onPress={() => router.push({ pathname: '/quotes/new', params: { id: quote.id } })}
            >
              {t('quote.action.edit')}
            </Button>
          ) : (
            <Button
              key={action}
              appearance={action === 'cancel' ? 'outline' : 'solid'}
              tone={action === 'cancel' ? 'danger' : 'accent'}
              size="sm"
              loading={act.isPending && act.variables === action}
              disabled={!allowed || act.isPending}
              onPress={() =>
                CONFIRMED.includes(action) ? setConfirming(action) : act.mutate(action)
              }
            >
              {t(`quote.action.${action}`)}
            </Button>
          ),
        )}
        <Button appearance="outline" size="sm" loading={pdf.isPending} onPress={() => pdf.mutate()}>
          {t('quote.action.pdf')}
        </Button>
      </View>
      {confirming ? (
        <View className="gap-3 rounded-xl border border-border p-4">
          <Text variant="body-2-regular">{t(`quote.confirm.${confirming}`)}</Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              appearance="solid"
              tone={confirming === 'cancel' ? 'danger' : 'accent'}
              size="sm"
              loading={act.isPending}
              onPress={() => act.mutate(confirming)}
            >
              {t(`quote.confirm.${confirming}Yes`)}
            </Button>
            <Button
              appearance="plain"
              size="sm"
              disabled={act.isPending}
              onPress={() => setConfirming(null)}
            >
              {t('quote.confirm.keep')}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function priceOf(line: CheckoutLineItem): Price | null {
  const price = line.price as Price | string | null;
  return price !== null && typeof price !== 'string' ? price : null;
}

function LineRow({ line }: { line: CheckoutLineItem }) {
  const price = priceOf(line);
  return (
    <View className="flex-row flex-wrap justify-between gap-x-4 gap-y-1 py-2 border-b border-border">
      <View className="flex-1 min-w-48 gap-1">
        <Text variant="body-2-regular">{line.description}</Text>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {`${line.quantity} × ${price ? formatPriceLabel(price) : line.currency}`}
          {` · ${t(price?.recurring ? 'quote.lineRecurring' : 'quote.lineOnce')}`}
        </Text>
      </View>
      <Text variant="body-2-semibold" selectable>
        {formatSignedAmount(line.amount_subtotal, line.currency)}
      </Text>
    </View>
  );
}

function QuoteDetail({
  scope,
  quote,
  lines,
}: {
  scope: DashboardScope;
  quote: Quote;
  lines: CheckoutLineItem[];
}) {
  const router = useRouter();
  const customerId = refId(quote.customer as string | { id: string });
  const invoiceId = refId(quote.invoice as string | { id: string } | null);
  const subscriptionId = refId(quote.subscription as string | { id: string } | null);
  const money = (amount: string) => formatSignedAmount(amount, quote.currency);
  const tax = quote.total_details.amount_tax;
  const taxProblem =
    quote.status === 'draft' &&
    (quote.automatic_tax.status === 'failed' ||
      quote.automatic_tax.status === 'requires_location_inputs');
  const transitions = quote.status_transitions;
  return (
    <View className="gap-6">
      <DetailHeader
        headline={money(quote.amount_total)}
        status={<QuoteStatusBadge status={quote.status} />}
        id={quote.id}
        facts={[
          { label: t('list.column.number'), value: quote.number ?? t('quote.draftNumber') },
          { label: t('quote.field.expires'), value: <Timestamp seconds={quote.expires_at} /> },
          { label: t('list.column.created'), value: <Timestamp seconds={quote.created} /> },
        ]}
      />
      <Actions scope={scope} quote={quote} />
      {taxProblem ? (
        <Text variant="body-2-regular" className="text-destructive">
          {t('quote.finalizeFailed', {
            reason: `${t('invoice.automaticTax', { status: quote.automatic_tax.status ?? '' })}.`,
          })}
        </Text>
      ) : null}
      <DetailLayout
        aside={
          <Section title={t('quote.details')}>
            <Field label={t('quote.field.id')} value={quote.id} mono />
            <Field
              label={t('quote.field.customer')}
              value={
                customerId ? (
                  <LinkButton
                    size="sm"
                    onPress={() =>
                      router.push({ pathname: '/customers/[id]', params: { id: customerId } })
                    }
                  >
                    {customerId}
                  </LinkButton>
                ) : (
                  '—'
                )
              }
            />
            {invoiceId ? (
              <Field
                label={t('quote.field.invoice')}
                value={
                  <LinkButton
                    size="sm"
                    onPress={() =>
                      router.push({ pathname: '/invoices/[id]', params: { id: invoiceId } })
                    }
                  >
                    {invoiceId}
                  </LinkButton>
                }
              />
            ) : null}
            {subscriptionId ? (
              <Field
                label={t('quote.field.subscription')}
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
              label={t('subscription.field.collection')}
              value={t(`collection.${quote.collection_method}`)}
            />
            {quote.collection_method === 'send_invoice' ? (
              <Field
                label={t('quote.field.daysUntilDue')}
                value={
                  quote.invoice_settings.days_until_due === null
                    ? t('quote.field.daysUntilDueDefault')
                    : String(quote.invoice_settings.days_until_due)
                }
              />
            ) : null}
            {quote.subscription_data.trial_period_days !== null ? (
              <Field
                label={t('quote.field.trial')}
                value={t('quote.field.trialDays', {
                  days: String(quote.subscription_data.trial_period_days),
                })}
              />
            ) : null}
            <Field
              label={t('quote.field.tax')}
              value={
                quote.automatic_tax.enabled
                  ? t('invoice.automaticTax', {
                      status: quote.automatic_tax.status ?? t('quote.taxPending'),
                    })
                  : t('invoice.noAutomaticTax')
              }
            />
            {quote.header ? <Field label={t('quote.field.header')} value={quote.header} /> : null}
            {quote.description ? (
              <Field label={t('quote.field.description')} value={quote.description} />
            ) : null}
            {quote.footer ? <Field label={t('quote.field.footer')} value={quote.footer} /> : null}
          </Section>
        }
      >
        <Section title={t('quote.lines')}>
          {lines.map((line) => (
            <LineRow key={line.id} line={line} />
          ))}
          <Field label={t('quote.subtotal')} value={money(quote.amount_subtotal)} />
          {quote.total_details.amount_discount !== '0' ? (
            <Field
              label={t('quote.discount')}
              value={`-${money(quote.total_details.amount_discount)}`}
            />
          ) : null}
          <Field label={t('quote.tax')} value={tax === null ? t('quote.taxPending') : money(tax)} />
          <Field label={t('quote.total')} value={money(quote.amount_total)} />
        </Section>
        <Section title={t('quote.timeline')}>
          <Field label={t('quote.created')} value={formatInstant(quote.created)} />
          <Field label={t('quote.finalized')} value={formatInstant(transitions.finalized_at)} />
          <Field label={t('quote.accepted')} value={formatInstant(transitions.accepted_at)} />
          <Field label={t('quote.canceled')} value={formatInstant(transitions.canceled_at)} />
        </Section>
      </DetailLayout>
    </View>
  );
}

function QuoteLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useQuote(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('quote.title')} />;
  if (query.isError) {
    // A 404 for this object: it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('quote.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <QuoteDetail scope={scope} quote={query.data.quote} lines={query.data.lines} />;
}

export default function QuoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('quote.title')}>
      {({ scope }) => (id ? <QuoteLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
