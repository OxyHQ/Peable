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
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { formatInstant } from '../format/time';
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

/** The "Load more" row under every paged list. */
export function LoadMore({
  visible,
  loading,
  onPress,
}: {
  visible: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  if (!visible) return null;
  return (
    <View className="items-center pt-2">
      <Button appearance="outline" loading={loading} onPress={onPress}>
        {t('action.loadMore')}
      </Button>
    </View>
  );
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

export function SubscriptionRow({ subscription }: { subscription: Subscription }) {
  const router = useRouter();
  return (
    <View className="gap-1 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <SubscriptionStatusBadge status={subscription.status} />
        <LinkButton
          size="sm"
          accessibilityLabel={`${t('subscription.title')} ${subscription.id}`}
          onPress={() =>
            router.push({ pathname: '/subscriptions/[id]', params: { id: subscription.id } })
          }
        >
          {subscriptionSummary(subscription)}
        </LinkButton>
        {subscription.cancel_at_period_end ? (
          <Badge
            appearance="subtle"
            tone="warning"
            size="label-small"
            content={t('subscription.endsAtPeriodEnd')}
          />
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
          {subscription.id}
        </Text>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('subscription.periodEnds', { date: formatInstant(subscription.current_period_end) })}
        </Text>
      </View>
    </View>
  );
}

export function InvoiceRow({ invoice }: { invoice: Invoice }) {
  const router = useRouter();
  return (
    <View className="gap-1 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <InvoiceStatusBadge status={invoice.status} />
        <LinkButton
          size="sm"
          accessibilityLabel={`${t('invoice.title')} ${invoice.number ?? invoice.id}`}
          onPress={() => router.push({ pathname: '/invoices/[id]', params: { id: invoice.id } })}
        >
          {invoice.number ?? t('invoice.draftNumber')}
        </LinkButton>
        <Text variant="body-2-semibold" selectable>
          {formatSignedAmount(invoice.total, invoice.currency)}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
          {invoice.id}
        </Text>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {formatInstant(invoice.created)}
        </Text>
        {invoice.due_date ? (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('invoice.due', { date: formatInstant(invoice.due_date) })}
          </Text>
        ) : null}
      </View>
    </View>
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
