import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { RequestLog } from '@peable.to/shared-types';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError, isOrbitApiError } from '@/api/transport';
import { formatDuration, requestStatusTone } from '@/developers/requestLogs';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { ToneBadge } from '@/ui/StatusBadge';

function LogDetail({ log }: { log: RequestLog }) {
  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap items-center gap-3">
        <ToneBadge tone={requestStatusTone(log.status)} label={String(log.status)} />
        <Text variant="title-2-semibold" selectable className="font-mono">
          {`${log.method} ${log.path}`}
        </Text>
      </View>
      <Section
        title={t('developers.logDetail.details')}
        description={t('developers.logDetail.intro')}
      >
        <Field label={t('developers.logDetail.id')} value={log.id} mono />
        <Field label={t('developers.logs.method')} value={log.method} mono />
        <Field label={t('developers.logDetail.path')} value={log.path} mono />
        <Field label={t('developers.logs.status')} value={String(log.status)} mono />
        <Field label={t('developers.logDetail.duration')} value={formatDuration(log.duration_ms)} />
        <Field
          label={t('developers.logDetail.idempotencyKey')}
          value={log.idempotency_key ?? t('developers.logDetail.none')}
          mono={log.idempotency_key !== null}
        />
        <Field
          label={t('payment.field.mode')}
          value={log.livemode ? t('scope.live') : t('scope.test')}
        />
        <Field label={t('developers.logDetail.created')} value={formatInstant(log.created)} />
      </Section>
    </View>
  );
}

function LogLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useQuery({
    queryKey: ['orbit', scope.applicationId, scope.environment, 'request_log', id],
    queryFn: () => dashboardApi.requestLogs.retrieve(scope, id),
  });
  if (query.isPending) return <Loading accessibilityLabel={t('developers.logs.request')} />;
  if (query.isError) {
    // 404: not this merchant's request, or older than the 30 days kept.
    if (isOrbitApiError(query.error) && query.error.status === 404) {
      return (
        <EmptyState
          title={t('developers.logDetail.notFound')}
          description={describeError(query.error, t('developers.logDetail.notFoundHelp'))}
        />
      );
    }
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <LogDetail log={query.data} />;
}

export default function RequestLogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('developers.logs.request')}>
      {({ scope }) => (id ? <LogLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
