import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RadarRule } from '@peable.to/shared-types';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { RuleActionBadge, ruleActionLabel } from '@/radar/RadarParts';
import { RuleEditor } from '@/radar/RuleEditor';
import { radarKeys, useRule } from '@/radar/useRadar';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { DetailHeader, ErrorNotice, OrbitScreen } from '@/ui/OrbitScreen';
import { isNotFound, NotFound, PageSkeleton } from '@/ui/states';

/** Delete, behind a confirmation: evaluations and reviews keep the rule as it was. */
function DeleteRule({ scope, rule }: { scope: DashboardScope; rule: RadarRule }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => dashboardApi.radar.rules.delete(scope, rule.id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: radarKeys.rule(scope, rule.id) });
      void queryClient.invalidateQueries({ queryKey: [...radarKeys.all(scope), 'rules'] });
      toast.success(t('radar.deleted'));
      router.replace('/radar');
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  return (
    <>
      <Button
        appearance="outline"
        tone="danger"
        size="sm"
        loading={remove.isPending}
        disabled={remove.isPending}
        onPress={() => setConfirming(true)}
      >
        {t('radar.delete')}
      </Button>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title={t('radar.confirmDelete.title')}
        description={t('radar.confirmDelete.body')}
        confirmLabel={t('radar.confirmDelete.action')}
        cancelLabel={t('action.cancel')}
        destructive
        defaultAction="cancel"
        onConfirm={() => {
          setConfirming(false);
          remove.mutate();
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

function RuleDetail({ scope, rule }: { scope: DashboardScope; rule: RadarRule }) {
  const { can } = useDashboardPermissions();
  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap items-start justify-between gap-3">
        <View className="flex-1 min-w-64">
          <DetailHeader
            headline={rule.description ?? ruleActionLabel(rule.action)}
            status={<RuleActionBadge action={rule.action} />}
            id={rule.id}
            facts={[
              { label: t('radar.field.version'), value: String(rule.version) },
              {
                label: t('radar.field.status'),
                value: rule.enabled ? t('radar.enabled') : t('radar.disabled'),
              },
              { label: t('radar.field.created'), value: formatInstant(rule.created) },
              { label: t('radar.field.updated'), value: formatInstant(rule.updated) },
            ]}
          />
        </View>
        {can('money') ? <DeleteRule scope={scope} rule={rule} /> : null}
      </View>
      {/* Keyed by version and switch: a saved change is what the form edits next. */}
      <RuleEditor
        key={`${rule.id}:${rule.version}:${String(rule.enabled)}:${rule.updated}`}
        scope={scope}
        rule={rule}
      />
    </View>
  );
}

function RuleLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useRule(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('radar.rule.title')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): deleted, or another mode's.
    if (isNotFound(query.error)) return <NotFound title={t('radar.rule.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <RuleDetail scope={scope} rule={query.data} />;
}

export default function RiskRuleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('radar.rule.title')}>
      {({ scope }) => (id ? <RuleLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
