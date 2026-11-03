import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { WebhookEvent } from '@peable.to/shared-types';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError, isOrbitApiError } from '@/api/transport';
import { requestLogPath } from '@/developers/requestLogs';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { DeliveryStatusBadge } from '@/ui/StatusBadge';

const eventKey = (scope: DashboardScope, id: string) => [
  'orbit',
  scope.applicationId,
  scope.environment,
  'event',
  id,
];

/** A JSON value as an indented block, for reading — never for editing. */
function JsonBlock({ value }: { value: unknown }) {
  return (
    <View className="rounded-xl border border-border bg-muted p-3">
      <Text variant="caption-1-regular" selectable className="font-mono">
        {JSON.stringify(value, null, 2)}
      </Text>
    </View>
  );
}

/** Where this event was sent: one delivery per endpoint that listens for it. */
function Deliveries({ scope, event }: { scope: DashboardScope; event: WebhookEvent }) {
  const query = useQuery({
    queryKey: [...eventKey(scope, event.id), 'deliveries'],
    queryFn: () => dashboardApi.webhookDeliveries.list(scope, { event: event.id, limit: 100 }),
  });
  if (query.isPending) return <Loading accessibilityLabel={t('developers.webhooks')} />;
  if (query.isError)
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data.data.length) {
    return (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('developers.eventDetail.noDeliveries')}
      </Text>
    );
  }
  return (
    <View>
      {query.data.data.map((delivery) => (
        <View
          key={delivery.id}
          className="flex-row flex-wrap items-center gap-x-3 gap-y-1 py-2 border-b border-border"
        >
          <DeliveryStatusBadge status={delivery.last_status} />
          <Text variant="body-2-regular" selectable className="font-mono flex-1 min-w-48">
            {delivery.url}
          </Text>
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('developers.attempts', { count: delivery.attempts })}
          </Text>
        </View>
      ))}
    </View>
  );
}

function EventDetail({ scope, event }: { scope: DashboardScope; event: WebhookEvent }) {
  const router = useRouter();
  const requestId = event.request.id;
  return (
    <View className="gap-6">
      <Text variant="title-2-semibold" selectable className="font-mono">
        {event.type}
      </Text>
      <Section title={t('developers.eventDetail.details')}>
        <Field label={t('developers.eventDetail.id')} value={event.id} mono />
        <Field label={t('developers.eventDetail.created')} value={formatInstant(event.created)} />
        <Field label={t('developers.eventDetail.apiVersion')} value={event.api_version} mono />
        {event.account ? (
          <Field label={t('developers.eventDetail.account')} value={event.account} mono />
        ) : null}
        <Field
          label={t('developers.eventDetail.request')}
          value={
            requestId ? (
              <LinkButton
                size="sm"
                accessibilityLabel={t('developers.event.request', { id: requestId })}
                onPress={() => router.push(requestLogPath(requestId))}
              >
                {requestId}
              </LinkButton>
            ) : (
              t('developers.eventDetail.noRequest')
            )
          }
        />
        {event.request.idempotency_key ? (
          <Field
            label={t('developers.logDetail.idempotencyKey')}
            value={event.request.idempotency_key}
            mono
          />
        ) : null}
      </Section>
      <Section title={t('developers.eventDetail.object')}>
        <JsonBlock value={event.data.object} />
      </Section>
      {event.data.previous_attributes ? (
        <Section
          title={t('developers.eventDetail.previous')}
          description={t('developers.eventDetail.previousHelp')}
        >
          <JsonBlock value={event.data.previous_attributes} />
        </Section>
      ) : null}
      <Section title={t('developers.webhooks')}>
        <Deliveries scope={scope} event={event} />
      </Section>
    </View>
  );
}

function EventLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useQuery({
    queryKey: eventKey(scope, id),
    queryFn: () => dashboardApi.events.retrieve(scope, id),
  });
  if (query.isPending) return <Loading accessibilityLabel={t('developers.event')} />;
  if (query.isError) {
    if (isOrbitApiError(query.error) && query.error.status === 404) {
      return (
        <EmptyState
          title={t('developers.eventDetail.notFound')}
          description={describeError(query.error, t('developers.eventDetail.notFound'))}
        />
      );
    }
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <EventDetail scope={scope} event={query.data} />;
}

export default function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return (
    <OrbitScreen
      title={t('developers.event')}
      actions={
        <Button
          appearance="plain"
          size="sm"
          leadingIcon={RiArrowLeftLine}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/developers'))}
        >
          {t('nav.developers')}
        </Button>
      }
    >
      {({ scope }) => (id ? <EventLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
