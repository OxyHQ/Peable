import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RadarRule, RadarRuleAction } from '@peable.to/shared-types';
import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { Predicate, RuleActionBadge, ruleActionLabel } from '@/radar/RadarParts';
import { RADAR_LIMITS, RADAR_RULE_ACTIONS } from '@/radar/ruleForm';
import { radarKeys, useRulePages } from '@/radar/useRadar';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, ListFooter, SetupPayments, OrbitScreen } from '@/ui/OrbitScreen';
import { ListEmpty, PageSkeleton } from '@/ui/states';

const ALL = 'all';
// Built at render: the language can change while Orbit is open.
const options = () => [
  { value: ALL, label: t('radar.filter.all') },
  ...RADAR_RULE_ACTIONS.map((action) => ({ value: action, label: ruleActionLabel(action) })),
];

/** One rule: what it does, its condition, and a switch that takes effect at once. */
function RuleRow({ scope, rule }: { scope: DashboardScope; rule: RadarRule }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const permitted = useDashboardPermissions().can('money');
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => dashboardApi.radar.rules.update(scope, rule.id, { enabled }),
    onSuccess: (saved) => {
      queryClient.setQueryData(radarKeys.rule(scope, saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: [...radarKeys.all(scope), 'rules'] });
      toast.success(t(saved.enabled ? 'radar.enabledNow' : 'radar.disabledNow'));
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  return (
    <View className="flex-row flex-wrap items-start gap-4 py-4 border-b border-border">
      <View className="flex-1 min-w-64 gap-1.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <RuleActionBadge action={rule.action} />
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('radar.version', { version: rule.version })}
          </Text>
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('radar.updated', { at: formatInstant(rule.updated) })}
          </Text>
        </View>
        <Predicate text={rule.predicate} lines={4} />
        {rule.description ? (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {rule.description}
          </Text>
        ) : null}
      </View>
      <View className="flex-row items-center gap-3">
        <Switch
          checked={rule.enabled}
          onCheckedChange={(enabled) => toggle.mutate(enabled)}
          disabled={!permitted || toggle.isPending}
          accessibilityLabel={t('radar.enabledFor', { id: rule.id })}
        />
        <Text variant="caption-1-medium" className="w-16">
          {rule.enabled ? t('radar.enabled') : t('radar.disabled')}
        </Text>
        <Button
          appearance="outline"
          size="sm"
          onPress={() => router.push({ pathname: '/radar/[id]', params: { id: rule.id } })}
        >
          {permitted ? t('radar.edit') : t('radar.view')}
        </Button>
      </View>
    </View>
  );
}

function RuleList({ scope, action }: { scope: DashboardScope; action: RadarRuleAction | null }) {
  const router = useRouter();
  const { can } = useDashboardPermissions();
  const pages = useRulePages(scope, action);
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('radar.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <SetupPayments environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const rules = pages.data.pages.flatMap((page) => page.data);
  if (!rules.length) {
    return action ? (
      <EmptyState
        variant="compact"
        title={t('radar.empty.title')}
        description={t('radar.empty.body')}
      />
    ) : (
      <ListEmpty
        title={t('radar.empty.firstTitle')}
        description={t('radar.empty.firstBody')}
        {...(can('money')
          ? { action: { label: t('radar.new'), onPress: () => router.push('/radar/new') } }
          : {})}
      />
    );
  }
  return (
    <View className="gap-4">
      <View>
        {rules.map((rule) => (
          <RuleRow key={rule.id} scope={scope} rule={rule} />
        ))}
      </View>
      <ListFooter pages={pages} />
    </View>
  );
}

export default function RiskRulesScreen() {
  const router = useRouter();
  const { can } = useDashboardPermissions();
  const [action, setAction] = useState<RadarRuleAction | null>(null);
  return (
    <OrbitScreen
      title={t('radar.title')}
      description={t('radar.description', { max: RADAR_LIMITS.rulesPerMerchantMax })}
      actions={
        <Button
          appearance="solid"
          tone="accent"
          disabled={!can('money')}
          onPress={() => router.push('/radar/new')}
        >
          {t('radar.new')}
        </Button>
      }
      filters={
        <View className="w-56">
          <Choice
            size="sm"
            label={t('radar.filter')}
            value={action ?? ALL}
            options={options()}
            onChange={(next) => setAction(next === ALL ? null : (next as RadarRuleAction))}
          />
        </View>
      }
    >
      {({ scope }) => (
        <View className="gap-4">
          <Admonition type="info">
            <AdmonitionText>{`${t('radar.precedence')} ${t('radar.cardOnly')}`}</AdmonitionText>
          </Admonition>
          <RuleList scope={scope} action={action} />
        </View>
      )}
    </OrbitScreen>
  );
}
