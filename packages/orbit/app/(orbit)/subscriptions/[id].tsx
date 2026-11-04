import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Invoice, Subscription } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatSignedAmount } from '@/billing/amount';
import { InvoiceStatusBadge, refId, SubscriptionStatusBadge } from '@/billing/BillingParts';
import { subscriptionActions, type SubscriptionAction } from '@/billing/status';
import { billingKeys, useSubscription } from '@/billing/useBilling';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { DetailLayout, ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { PermissionNotice, isNotFound, NotFound, PageSkeleton } from '@/ui/states';

const fail = (error: unknown) => toast.error(describeError(error, t('error.generic')));

function Actions({ scope, subscription }: { scope: DashboardScope; subscription: Subscription }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const act = useMutation({
    mutationFn: (action: SubscriptionAction) => {
      switch (action) {
        case 'cancel_at_period_end':
          return dashboardApi.subscriptions.update(scope, subscription.id, {
            cancel_at_period_end: true,
          });
        case 'keep':
          return dashboardApi.subscriptions.update(scope, subscription.id, {
            cancel_at_period_end: false,
          });
        case 'pause_collection':
          return dashboardApi.subscriptions.update(scope, subscription.id, {
            pause_collection: { behavior: 'keep_as_draft' },
          });
        case 'resume_collection':
          return dashboardApi.subscriptions.update(scope, subscription.id, {
            pause_collection: '',
          });
        case 'resume':
          return dashboardApi.subscriptions.resume(scope, subscription.id);
        case 'cancel_now':
          return dashboardApi.subscriptions.cancel(scope, subscription.id, { prorate: true });
      }
    },
    onSuccess: () => {
      toast.success(t('subscription.updated'));
      void queryClient.invalidateQueries({ queryKey: billingKeys.all(scope) });
    },
    onError: fail,
  });
  const actions = subscriptionActions(subscription);
  if (actions.length === 0) return null;
  return (
    <View className="gap-2">
      <PermissionNotice action="money" />
      <View className="flex-row flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            appearance="outline"
            size="sm"
            tone={action === 'cancel_now' ? 'danger' : undefined}
            loading={act.isPending && act.variables === action}
            disabled={!can('money')}
            onPress={() => act.mutate(action)}
          >
            {t(`subscription.action.${action}`)}
          </Button>
        ))}
      </View>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('subscription.actionsHelp')}
      </Text>
    </View>
  );
}

function LatestInvoice({ invoice }: { invoice: Subscription['latest_invoice'] }) {
  const router = useRouter();
  const id = refId(invoice as string | { id: string } | null);
  if (!id) return <Text variant="body-2-regular">—</Text>;
  const expanded = typeof invoice === 'object' && invoice !== null ? (invoice as Invoice) : null;
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {expanded ? <InvoiceStatusBadge status={expanded.status} /> : null}
      <LinkButton
        size="sm"
        onPress={() => router.push({ pathname: '/invoices/[id]', params: { id } })}
      >
        {expanded?.number ?? id}
      </LinkButton>
      {expanded ? (
        <Text variant="body-2-regular">
          {formatSignedAmount(expanded.total, expanded.currency)}
        </Text>
      ) : null}
    </View>
  );
}

function SubscriptionDetail({
  scope,
  subscription,
}: {
  scope: DashboardScope;
  subscription: Subscription;
}) {
  const router = useRouter();
  const customerId = refId(subscription.customer as string | { id: string });
  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap items-center gap-3">
        <Text variant="title-1-bold" selectable>
          {subscription.id}
        </Text>
        <SubscriptionStatusBadge status={subscription.status} />
        {subscription.cancel_at_period_end ? (
          <Badge
            appearance="subtle"
            tone="warning"
            size="label-small"
            content={t('subscription.endsAtPeriodEnd')}
          />
        ) : null}
        {subscription.pause_collection ? (
          <Badge
            appearance="subtle"
            tone="neutral"
            size="label-small"
            content={t('subscription.collectionPaused')}
          />
        ) : null}
      </View>
      <Actions scope={scope} subscription={subscription} />
      <DetailLayout
        aside={
          <Section title={t('subscription.details')}>
            <Field
              label={t('subscription.field.customer')}
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
            <Field
              label={t('subscription.field.period')}
              value={`${formatInstant(subscription.current_period_start)} → ${formatInstant(subscription.current_period_end)}`}
            />
            {subscription.trial_end ? (
              <Field
                label={t('subscription.field.trialEnd')}
                value={formatInstant(subscription.trial_end)}
              />
            ) : null}
            <Field
              label={t('subscription.field.collection')}
              value={t(`collection.${subscription.collection_method}`)}
            />
            {subscription.cancel_at ? (
              <Field
                label={t('subscription.field.cancelAt')}
                value={formatInstant(subscription.cancel_at)}
              />
            ) : null}
            {subscription.ended_at ? (
              <Field
                label={t('subscription.field.endedAt')}
                value={formatInstant(subscription.ended_at)}
              />
            ) : null}
            <Field
              label={t('subscription.field.latestInvoice')}
              value={<LatestInvoice invoice={subscription.latest_invoice} />}
            />
            {subscription.test_clock ? (
              <Field label={t('customer.field.testClock')} value={subscription.test_clock} mono />
            ) : null}
            <Field
              label={t('subscription.field.created')}
              value={formatInstant(subscription.created)}
            />
          </Section>
        }
      >
        <Section title={t('subscription.items')}>
          {subscription.items.data.map((item) => (
            <View
              key={item.id}
              className="flex-row flex-wrap gap-x-4 gap-y-1 py-2 border-b border-border"
            >
              <Text variant="body-2-semibold">
                {item.price.unit_amount === null
                  ? t('product.price.tiered')
                  : formatSignedAmount(item.price.unit_amount, item.price.currency)}
                {item.price.recurring ? ` / ${item.price.recurring.interval}` : ''}
              </Text>
              <Text variant="body-2-regular">
                {t('subscription.quantity', { quantity: item.quantity })}
              </Text>
              <Text
                variant="caption-1-regular"
                selectable
                className="text-muted-foreground font-mono"
              >
                {item.price.id}
              </Text>
            </View>
          ))}
        </Section>
      </DetailLayout>
    </View>
  );
}

function SubscriptionLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useSubscription(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('subscription.title')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('subscription.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <SubscriptionDetail scope={scope} subscription={query.data} />;
}

export default function SubscriptionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('subscription.title')}>
      {({ scope }) => (id ? <SubscriptionLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
