import type { ReactNode } from 'react';
import { Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import type {
  Invoice,
  InvoiceStatus,
  Subscription,
  SubscriptionStatus,
} from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { Text } from '@oxy.so/bloom/typography';
import { AmountText, RowLink, Timestamp } from '../ui/data';
import { t } from '../i18n';
import { formatSignedAmount } from './amount';
import {
  invoiceStatusLabel,
  invoiceStatusTone,
  subscriptionStatusLabel,
  subscriptionStatusTone,
} from './status';

export function SubscriptionStatusBadge({ status }: { status: SubscriptionStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={subscriptionStatusTone(status)}
      size="label-small"
      content={subscriptionStatusLabel(status)}
    />
  );
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={invoiceStatusTone(status)}
      size="label-small"
      content={invoiceStatusLabel(status)}
    />
  );
}

/** A reference as its id, whether or not the read expanded it. */
export function refId(reference: string | { id: string } | null): string | null {
  return reference === null || typeof reference === 'string' ? reference : reference.id;
}

/** Open a payer-facing page (hosted invoice, PDF) — public URLs, no Orbit credential in them. */
export function ExternalLink({ url, label }: { url: string | null; label: string }) {
  if (!url) return null;
  return (
    <Button appearance="outline" size="sm" onPress={() => void Linking.openURL(url)}>
      {label}
    </Button>
  );
}

/** The amount summary of a subscription: each item's unit price × quantity. */
export function subscriptionSummary(subscription: Subscription): string {
  return subscription.items.data
    .map((item) => {
      const unit = item.price.unit_amount;
      const amount =
        unit === null ? t('product.price.tiered') : formatSignedAmount(unit, item.price.currency);
      return item.quantity === 1 ? amount : `${item.quantity} × ${amount}`;
    })
    .join(' + ');
}

const SUBSCRIPTION_COLUMNS = {
  amount: { flex: 3, minWidth: 180 },
  status: { flex: 2, minWidth: 130 },
  customer: { flex: 2, minWidth: 160 },
  periodEnd: { flex: 2, minWidth: 140 },
  created: { flex: 2, minWidth: 140 },
} as const;

/** Subscriptions, Stripe's table: what it charges, status, customer, current period, created; a row opens it. */
export function SubscriptionsTable({
  subscriptions,
  empty,
}: {
  subscriptions: readonly Subscription[];
  empty?: ReactNode;
}) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('subscriptions.title')} minWidth={760} size="sm">
      <TableHeader>
        <TableColumn {...SUBSCRIPTION_COLUMNS.amount}>{t('list.column.product')}</TableColumn>
        <TableColumn {...SUBSCRIPTION_COLUMNS.status}>{t('list.column.status')}</TableColumn>
        <TableColumn {...SUBSCRIPTION_COLUMNS.customer}>{t('list.column.customer')}</TableColumn>
        <TableColumn {...SUBSCRIPTION_COLUMNS.periodEnd}>{t('list.column.periodEnd')}</TableColumn>
        <TableColumn {...SUBSCRIPTION_COLUMNS.created}>{t('list.column.created')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {subscriptions.map((subscription) => (
          <RowLink
            key={subscription.id}
            accessibilityLabel={`${t('subscription.title')} ${subscription.id}`}
            onPress={() =>
              router.push({ pathname: '/subscriptions/[id]', params: { id: subscription.id } })
            }
          >
            <TableRow>
              <TableCell {...SUBSCRIPTION_COLUMNS.amount}>
                <View>
                  <Text variant="body-2-medium" numberOfLines={1}>
                    {subscriptionSummary(subscription)}
                  </Text>
                  <Text
                    variant="caption-1-regular"
                    numberOfLines={1}
                    className="font-mono text-muted-foreground"
                  >
                    {subscription.id}
                  </Text>
                </View>
              </TableCell>
              <TableCell {...SUBSCRIPTION_COLUMNS.status}>
                <View className="flex-row flex-wrap gap-1">
                  <SubscriptionStatusBadge status={subscription.status} />
                  {subscription.cancel_at_period_end ? (
                    <Badge
                      appearance="subtle"
                      tone="warning"
                      size="label-small"
                      content={t('subscription.endsAtPeriodEnd')}
                    />
                  ) : null}
                </View>
              </TableCell>
              <TableCell {...SUBSCRIPTION_COLUMNS.customer}>
                <Text variant="body-2-regular" numberOfLines={1} className="font-mono">
                  {refId(subscription.customer) ?? '—'}
                </Text>
              </TableCell>
              <TableCell {...SUBSCRIPTION_COLUMNS.periodEnd}>
                <Timestamp seconds={subscription.current_period_end} muted />
              </TableCell>
              <TableCell {...SUBSCRIPTION_COLUMNS.created}>
                <Timestamp seconds={subscription.created} muted />
              </TableCell>
            </TableRow>
          </RowLink>
        ))}
      </TableBody>
    </Table>
  );
}

const INVOICE_COLUMNS = {
  total: { flex: 2, minWidth: 120, align: 'end' },
  status: { flex: 2, minWidth: 120 },
  number: { flex: 2, minWidth: 140 },
  customer: { flex: 2, minWidth: 160 },
  due: { flex: 2, minWidth: 130 },
  created: { flex: 2, minWidth: 130 },
} as const;

/** Invoices, Stripe's table: total on the right, status, number, customer, due, created; a row opens it. */
export function InvoicesTable({
  invoices,
  empty,
}: {
  invoices: readonly Invoice[];
  empty?: ReactNode;
}) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('invoices.title')} minWidth={820} size="sm">
      <TableHeader>
        <TableColumn {...INVOICE_COLUMNS.total}>{t('list.column.total')}</TableColumn>
        <TableColumn {...INVOICE_COLUMNS.status}>{t('list.column.status')}</TableColumn>
        <TableColumn {...INVOICE_COLUMNS.number}>{t('list.column.number')}</TableColumn>
        <TableColumn {...INVOICE_COLUMNS.customer}>{t('list.column.customer')}</TableColumn>
        <TableColumn {...INVOICE_COLUMNS.due}>{t('list.column.due')}</TableColumn>
        <TableColumn {...INVOICE_COLUMNS.created}>{t('list.column.created')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {invoices.map((invoice) => (
          <RowLink
            key={invoice.id}
            accessibilityLabel={`${t('invoice.title')} ${invoice.number ?? invoice.id}`}
            onPress={() => router.push({ pathname: '/invoices/[id]', params: { id: invoice.id } })}
          >
            <TableRow>
              <TableCell {...INVOICE_COLUMNS.total}>
                <AmountText strong>
                  {formatSignedAmount(invoice.total, invoice.currency)}
                </AmountText>
              </TableCell>
              <TableCell {...INVOICE_COLUMNS.status}>
                <InvoiceStatusBadge status={invoice.status} />
              </TableCell>
              <TableCell {...INVOICE_COLUMNS.number}>
                <Text variant="body-2-regular" numberOfLines={1} className="font-mono">
                  {invoice.number ?? t('invoice.draftNumber')}
                </Text>
              </TableCell>
              <TableCell {...INVOICE_COLUMNS.customer}>
                <Text variant="body-2-regular" numberOfLines={1} className="font-mono">
                  {refId(invoice.customer) ?? '—'}
                </Text>
              </TableCell>
              <TableCell {...INVOICE_COLUMNS.due}>
                <Timestamp seconds={invoice.due_date} muted />
              </TableCell>
              <TableCell {...INVOICE_COLUMNS.created}>
                <Timestamp seconds={invoice.created} muted />
              </TableCell>
            </TableRow>
          </RowLink>
        ))}
      </TableBody>
    </Table>
  );
}

/** A small titled list with an empty message. */
export function RowList({ items, empty }: { items: ReactNode[]; empty: string }) {
  if (items.length === 0) {
    return (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {empty}
      </Text>
    );
  }
  return <View>{items}</View>;
}
