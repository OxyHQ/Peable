import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WebhookDelivery } from '@peable.to/shared-types';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import { isMerchantMissing, type DashboardScope, type ListPage } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatInstant, formatRelative, nowSeconds } from '@/format/time';
import { t } from '@/i18n';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { DeliveryStatusBadge } from '@/ui/StatusBadge';

const PAGE_SIZE = 25;

const deliveryKeys = (scope: DashboardScope) => [
  'orbit',
  scope.applicationId,
  scope.environment,
  'webhook_deliveries',
];

function DeliveryRow({
  delivery,
  onRedeliver,
  redelivering,
}: {
  delivery: WebhookDelivery;
  onRedeliver: () => void;
  redelivering: boolean;
}) {
  const router = useRouter();
  const now = nowSeconds();
  return (
    <View className="gap-2 py-4 border-b border-border">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-row flex-wrap items-center gap-2 flex-1 min-w-64">
          <DeliveryStatusBadge status={delivery.last_status} />
          <Text variant="body-2-semibold" selectable className="font-mono">
            {delivery.event_type}
          </Text>
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {formatInstant(delivery.created)}
          </Text>
        </View>
        <Button
          appearance="outline"
          size="sm"
          loading={redelivering}
          onPress={onRedeliver}
          accessibilityLabel={`${t('developers.redeliver')} ${delivery.id}`}
        >
          {t('developers.redeliver')}
        </Button>
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('developers.attempts', { count: delivery.attempts })}
        </Text>
        {delivery.next_attempt_at !== undefined ? (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('developers.nextAttempt', {
              at: `${formatInstant(delivery.next_attempt_at)} (${formatRelative(delivery.next_attempt_at, now)})`,
            })}
          </Text>
        ) : null}
        <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
          {delivery.id}
        </Text>
      </View>
      <Text variant="caption-1-regular" selectable className="text-muted-foreground">
        {t('developers.endpoint')}: {delivery.url}
      </Text>
      {delivery.last_error ? (
        <Text variant="caption-1-regular" selectable className="text-destructive">
          {t('developers.lastError', { error: delivery.last_error })}
        </Text>
      ) : null}
      {delivery.intent_id ? (
        <View className="flex-row">
          <LinkButton
            size="sm"
            onPress={() =>
              router.navigate({
                pathname: '/payments/[id]',
                params: { id: delivery.intent_id ?? '' },
              })
            }
          >
            {t('developers.payment', { id: delivery.intent_id })}
          </LinkButton>
        </View>
      ) : null}
    </View>
  );
}

function Deliveries({ scope }: { scope: DashboardScope }) {
  const queryClient = useQueryClient();
  const pages = useInfiniteQuery({
    queryKey: deliveryKeys(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.webhookDeliveries.list(scope, {
        limit: PAGE_SIZE,
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<WebhookDelivery>) =>
      last.has_more ? last.data[last.data.length - 1]?.id : undefined,
  });
  const redeliver = useMutation({
    mutationFn: (deliveryId: string) => dashboardApi.webhookDeliveries.redeliver(scope, deliveryId),
    onSuccess: () => {
      toast.success(t('developers.redelivered'));
      void queryClient.invalidateQueries({ queryKey: deliveryKeys(scope) });
    },
    onError: (error) => {
      toast.error(describeError(error, t('error.generic')));
    },
  });

  if (pages.isPending) return <Loading accessibilityLabel={t('developers.webhooks')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const deliveries = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('developers.webhooks')} description={t('developers.webhooksIntro')}>
      {deliveries.length ? (
        deliveries.map((delivery) => (
          <DeliveryRow
            key={delivery.id}
            delivery={delivery}
            redelivering={redeliver.isPending && redeliver.variables === delivery.id}
            onRedeliver={() => redeliver.mutate(delivery.id)}
          />
        ))
      ) : (
        <EmptyState
          variant="compact"
          title={t('developers.empty.title')}
          description={t('developers.empty.body')}
        />
      )}
      {pages.hasNextPage ? (
        <View className="items-center pt-2">
          <Button
            appearance="outline"
            loading={pages.isFetchingNextPage}
            onPress={() => void pages.fetchNextPage()}
          >
            {t('action.loadMore')}
          </Button>
        </View>
      ) : null}
    </Section>
  );
}

export default function DevelopersScreen() {
  return (
    <OrbitScreen title={t('developers.title')}>
      {({ scope }) => <Deliveries scope={scope} />}
    </OrbitScreen>
  );
}
