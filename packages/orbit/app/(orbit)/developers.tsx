import { useState } from 'react';
import { View } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WebhookDelivery, WebhookEndpoint, WebhookEvent } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import { isMerchantMissing, type DashboardScope, type ListPage } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatInstant, formatRelative, nowSeconds } from '@/format/time';
import { t } from '@/i18n';
import { deliveryStatusLabel } from '@/payments/status';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { DeliveryStatusBadge } from '@/ui/StatusBadge';
import {
  buildEndpointBody,
  describeEnabledEvents,
  EMPTY_ENDPOINT_FORM,
  type EndpointForm,
  ROLL_OVERLAP_SECONDS,
} from '@/webhooks/endpointForm';

const PAGE_SIZE = 25;

/** Every key of this screen, so one change can refresh all three lists. */
const webhooksKey = (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment];
const endpointKeys = (scope: DashboardScope) => [...webhooksKey(scope), 'webhook_endpoints'];
const eventKeys = (scope: DashboardScope) => [...webhooksKey(scope), 'events'];
const deliveryKeys = (scope: DashboardScope) => [...webhooksKey(scope), 'webhook_deliveries'];

/** A page walked with `starting_after`, as every Peable list is. */
function usePagedList<T extends { id: string }>(
  queryKey: readonly unknown[],
  fetchPage: (startingAfter: string | undefined) => Promise<ListPage<T>>,
) {
  return useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (last: ListPage<T>) =>
      last.has_more ? last.data[last.data.length - 1]?.id : undefined,
  });
}

function LoadMore({
  pages,
}: {
  pages: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  if (!pages.hasNextPage) return null;
  return (
    <View className="items-center pt-2">
      <Button
        appearance="outline"
        loading={pages.isFetchingNextPage}
        onPress={() => void pages.fetchNextPage()}
      >
        {t('action.loadMore')}
      </Button>
    </View>
  );
}

/** The one moment a signing secret is visible: right after a create or a roll. */
function RevealedSecret({
  endpoint,
  onDismiss,
}: {
  endpoint: WebhookEndpoint;
  onDismiss: () => void;
}) {
  return (
    <View className="gap-2 rounded-xl border border-border p-4">
      <Text variant="body-2-semibold">{t('developers.secret.title', { url: endpoint.url })}</Text>
      <Text variant="body-2-regular" selectable className="font-mono">
        {endpoint.secret}
      </Text>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('developers.secret.body')}
      </Text>
      <View className="flex-row">
        <Button appearance="outline" size="sm" onPress={onDismiss}>
          {t('developers.secret.dismiss')}
        </Button>
      </View>
    </View>
  );
}

function endpointStatus(endpoint: WebhookEndpoint): { label: string; enabled: boolean } {
  if (endpoint.status === 'enabled')
    return { label: t('developers.endpoint.enabled'), enabled: true };
  return {
    label:
      endpoint.disabled_reason === 'delivery_failures'
        ? t('developers.endpoint.disabledFailing')
        : endpoint.disabled_reason === 'disabled_by_merchant'
          ? t('developers.endpoint.disabledByMerchant')
          : t('developers.endpoint.disabled'),
    enabled: false,
  };
}

function EndpointRow({
  scope,
  endpoint,
  onSecret,
}: {
  scope: DashboardScope;
  endpoint: WebhookEndpoint;
  onSecret: (endpoint: WebhookEndpoint) => void;
}) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: webhooksKey(scope) });
  const fail = (error: unknown) => toast.error(describeError(error, t('error.generic')));
  const status = endpointStatus(endpoint);

  const toggle = useMutation({
    mutationFn: () =>
      dashboardApi.webhookEndpoints.update(scope, endpoint.id, { disabled: status.enabled }),
    onSuccess: refresh,
    onError: fail,
  });
  const test = useMutation({
    mutationFn: () => dashboardApi.webhookEndpoints.sendTest(scope, endpoint.id),
    onSuccess: (delivery) => {
      toast.success(
        t('developers.endpoint.tested', { status: deliveryStatusLabel(delivery.last_status) }),
      );
      refresh();
    },
    onError: fail,
  });
  const roll = useMutation({
    mutationFn: () =>
      dashboardApi.webhookEndpoints.rollSecret(scope, endpoint.id, ROLL_OVERLAP_SECONDS),
    onSuccess: (rolled) => {
      onSecret(rolled);
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => dashboardApi.webhookEndpoints.delete(scope, endpoint.id),
    onSuccess: () => {
      toast.success(t('developers.endpoint.deleted'));
      refresh();
    },
    onError: fail,
  });

  return (
    <View className="gap-2 py-4 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge
          appearance="subtle"
          tone={status.enabled ? 'success' : 'danger'}
          size="label-small"
          content={status.label}
        />
        <Text variant="body-2-semibold" selectable className="font-mono flex-1 min-w-64">
          {endpoint.url}
        </Text>
      </View>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('developers.endpoint.events')}:{' '}
        {describeEnabledEvents(endpoint, t('developers.endpoint.allEvents'))}
      </Text>
      {endpoint.description ? (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {endpoint.description}
        </Text>
      ) : null}
      <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
        {endpoint.id}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          appearance="outline"
          size="sm"
          loading={test.isPending}
          disabled={!status.enabled}
          onPress={() => test.mutate()}
        >
          {t('developers.endpoint.test')}
        </Button>
        <Button
          appearance="outline"
          size="sm"
          loading={toggle.isPending}
          onPress={() => toggle.mutate()}
        >
          {status.enabled ? t('developers.endpoint.disable') : t('developers.endpoint.enable')}
        </Button>
        <Button
          appearance="outline"
          size="sm"
          loading={roll.isPending}
          onPress={() => roll.mutate()}
        >
          {t('developers.endpoint.roll')}
        </Button>
        <Button
          appearance="outline"
          tone="danger"
          size="sm"
          loading={remove.isPending}
          onPress={() => remove.mutate()}
        >
          {t('developers.endpoint.delete')}
        </Button>
      </View>
    </View>
  );
}

function AddEndpoint({
  scope,
  onCreated,
}: {
  scope: DashboardScope;
  onCreated: (endpoint: WebhookEndpoint) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<EndpointForm>(EMPTY_ENDPOINT_FORM);
  const [invalid, setInvalid] = useState<'url' | 'events' | null>(null);
  const set = (field: keyof EndpointForm) => (value: string) =>
    setForm((prior) => ({ ...prior, [field]: value }));
  const create = useMutation({
    mutationFn: (body: Parameters<typeof dashboardApi.webhookEndpoints.create>[1]) =>
      dashboardApi.webhookEndpoints.create(scope, body),
    onSuccess: (endpoint) => {
      toast.success(t('developers.endpoint.added'));
      setForm(EMPTY_ENDPOINT_FORM);
      onCreated(endpoint);
      void queryClient.invalidateQueries({ queryKey: endpointKeys(scope) });
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  const submit = () => {
    const result = buildEndpointBody(form);
    setInvalid(result.ok ? null : result.error);
    if (result.ok) create.mutate(result.body);
  };
  return (
    <View className="gap-4 pb-2">
      <FormField
        label={t('developers.endpoint.url')}
        value={form.url}
        onChange={set('url')}
        placeholder="https://example.com/peable/webhooks"
        hint={
          invalid === 'url' ? t('developers.endpoint.invalidUrl') : t('developers.endpoint.urlHelp')
        }
        invalid={invalid === 'url'}
        keyboardType="url"
        disabled={create.isPending}
      />
      <FormField
        label={t('developers.endpoint.events')}
        value={form.events}
        onChange={set('events')}
        hint={
          invalid === 'events'
            ? t('developers.endpoint.invalidEvents')
            : t('developers.endpoint.eventsHelp')
        }
        invalid={invalid === 'events'}
        disabled={create.isPending}
      />
      <FormField
        label={t('developers.endpoint.description')}
        value={form.description}
        onChange={set('description')}
        autoCapitalize="sentences"
        disabled={create.isPending}
      />
      <View className="flex-row justify-end">
        <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
          {t('developers.endpoint.add')}
        </Button>
      </View>
    </View>
  );
}

function Endpoints({ scope }: { scope: DashboardScope }) {
  const [revealed, setRevealed] = useState<WebhookEndpoint | null>(null);
  const pages = usePagedList(endpointKeys(scope), (startingAfter) =>
    dashboardApi.webhookEndpoints.list(scope, {
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }),
  );
  if (pages.isPending) return <Loading accessibilityLabel={t('developers.endpoints')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const endpoints = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('developers.endpoints')} description={t('developers.endpointsIntro')}>
      {revealed?.secret ? (
        <RevealedSecret endpoint={revealed} onDismiss={() => setRevealed(null)} />
      ) : null}
      <AddEndpoint scope={scope} onCreated={setRevealed} />
      {endpoints.length ? (
        endpoints.map((endpoint) => (
          <EndpointRow key={endpoint.id} scope={scope} endpoint={endpoint} onSecret={setRevealed} />
        ))
      ) : (
        <EmptyState
          variant="compact"
          title={t('developers.endpoints.empty.title')}
          description={t('developers.endpoints.empty.body')}
        />
      )}
      <LoadMore pages={pages} />
    </Section>
  );
}

function EventRow({ event }: { event: WebhookEvent }) {
  return (
    <View className="gap-1 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text variant="body-2-semibold" selectable className="font-mono">
          {event.type}
        </Text>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {formatInstant(event.created)}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
          {event.id}
        </Text>
        {event.request.id ? (
          <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
            {t('developers.event.request', { id: event.request.id })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Events({ scope }: { scope: DashboardScope }) {
  const pages = usePagedList(eventKeys(scope), (startingAfter) =>
    dashboardApi.events.list(scope, {
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }),
  );
  if (pages.isPending) return <Loading accessibilityLabel={t('developers.events')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return null;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const events = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('developers.events')} description={t('developers.eventsIntro')}>
      {events.length ? (
        events.map((event) => <EventRow key={event.id} event={event} />)
      ) : (
        <EmptyState
          variant="compact"
          title={t('developers.events.empty.title')}
          description={t('developers.events.empty.body')}
        />
      )}
      <LoadMore pages={pages} />
    </Section>
  );
}

function DeliveryRow({
  delivery,
  onRedeliver,
  redelivering,
}: {
  delivery: WebhookDelivery;
  onRedeliver: () => void;
  redelivering: boolean;
}) {
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
          {t('developers.event')}: {delivery.event_id}
        </Text>
      </View>
      <Text variant="caption-1-regular" selectable className="text-muted-foreground">
        {t('developers.endpoint')}: {delivery.url} ({delivery.webhook_endpoint_id})
      </Text>
      {delivery.last_error ? (
        <Text variant="caption-1-regular" selectable className="text-destructive">
          {t('developers.lastError', { error: delivery.last_error })}
        </Text>
      ) : null}
    </View>
  );
}

function Deliveries({ scope }: { scope: DashboardScope }) {
  const queryClient = useQueryClient();
  const pages = usePagedList(deliveryKeys(scope), (startingAfter) =>
    dashboardApi.webhookDeliveries.list(scope, {
      limit: PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }),
  );
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
    if (isMerchantMissing(pages.error)) return null;
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
      <LoadMore pages={pages} />
    </Section>
  );
}

export default function DevelopersScreen() {
  return (
    <OrbitScreen title={t('developers.title')}>
      {({ scope }) => (
        <View className="gap-6">
          <Endpoints scope={scope} />
          <Events scope={scope} />
          <Deliveries scope={scope} />
        </View>
      )}
    </OrbitScreen>
  );
}
