import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { RequestLog } from '@peable.to/shared-types';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { formatDuration, requestStatusTone } from '@/developers/requestLogs';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { ToneBadge } from '@/ui/StatusBadge';
import { isNotFound, NotFound, PageSkeleton } from '@/ui/states';

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
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('developers.logs.request')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('developers.logDetail.notFound')} />;
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
