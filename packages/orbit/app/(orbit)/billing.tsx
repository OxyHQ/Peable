import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BillingSettings,
  DunningFinalAction,
  DunningInvoiceAction,
  EntitlementFeature,
} from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import {
  buildFeatureBody,
  buildSettingsBody,
  DUNNING_FINAL_ACTION_OPTIONS,
  DUNNING_INVOICE_ACTION_OPTIONS,
  parseRetrySchedule,
  scheduleWindowDays,
  settingsFormOf,
  type SettingsForm,
  type SettingsFormError,
} from '@/billing/settingsForm';
import { billingKeys, useBillingSettings, useFeatures } from '@/billing/useBilling';
import { t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Choice } from '@/ui/Choice';
import { FormField } from '@/ui/FormField';
import { ActionPermissionNotice } from '@/ui/ActionPermissionNotice';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { PageSkeleton } from '@/ui/states';

const fail = (error: unknown) => toast.error(describeError(error, t('error.generic')));

function Toggle({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-2 py-2 border-b border-border">
      <Text variant="body-2-regular">{label}</Text>
      <Button
        appearance={value ? 'solid' : 'outline'}
        size="sm"
        disabled={disabled}
        onPress={() => onChange(!value)}
      >
        {value ? t('billing.on') : t('billing.off')}
      </Button>
    </View>
  );
}

function SettingsEditor({ scope, settings }: { scope: DashboardScope; settings: BillingSettings }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const locked = !can('money');
  const [form, setForm] = useState<SettingsForm>(() => settingsFormOf(settings));
  const [invalid, setInvalid] = useState<SettingsFormError | null>(null);
  const set =
    <K extends keyof SettingsForm>(field: K) =>
    (value: SettingsForm[K]) =>
      setForm((prior) => ({ ...prior, [field]: value }));
  const save = useMutation({
    mutationFn: (body: Parameters<typeof dashboardApi.billingSettings.update>[1]) =>
      dashboardApi.billingSettings.update(scope, body),
    onSuccess: (updated) => {
      toast.success(t('billing.saved'));
      setForm(settingsFormOf(updated));
      void queryClient.invalidateQueries({ queryKey: billingKeys.settings(scope) });
    },
    onError: fail,
  });
  const schedule = parseRetrySchedule(form.retrySchedule);
  const submit = () => {
    const result = buildSettingsBody(form, settings);
    setInvalid(result.ok ? null : result.error);
    if (!result.ok) return;
    if (Object.keys(result.body).length === 0) {
      toast.success(t('product.nothingChanged'));
      return;
    }
    save.mutate(result.body);
  };
  return (
    <Section title={t('billing.settings')} description={t('billing.settingsIntro')}>
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-48">
          <FormField
            label={t('billing.invoicePrefix')}
            value={form.invoicePrefix}
            onChange={set('invoicePrefix')}
            autoCapitalize="characters"
            invalid={invalid === 'invoicePrefix'}
            hint={t('billing.invoicePrefixHelp', { next: settings.next_invoice_sequence })}
            disabled={save.isPending || locked}
          />
        </View>
        <View className="flex-1 min-w-48">
          <FormField
            label={t('billing.daysUntilDue')}
            value={form.defaultDaysUntilDue}
            onChange={set('defaultDaysUntilDue')}
            keyboardType="number-pad"
            invalid={invalid === 'defaultDaysUntilDue'}
            hint={t('billing.daysUntilDueHelp')}
            disabled={save.isPending || locked}
          />
        </View>
      </View>
      <Text variant="headline-semibold">{t('billing.dunning')}</Text>
      <FormField
        label={t('billing.retrySchedule')}
        value={form.retrySchedule}
        onChange={set('retrySchedule')}
        invalid={invalid === 'retrySchedule'}
        hint={
          schedule === null
            ? t('billing.retryScheduleInvalid')
            : t('billing.retryScheduleHelp', {
                retries: schedule.length,
                days: scheduleWindowDays(schedule),
              })
        }
        disabled={save.isPending || locked}
      />
      <View className="flex-row flex-wrap gap-4">
        <View className="flex-1 min-w-48">
          <Choice
            label={t('billing.finalAction')}
            value={form.finalAction}
            options={DUNNING_FINAL_ACTION_OPTIONS.map((value) => ({
              value,
              label: t(`billing.finalAction.${value}`),
            }))}
            onChange={(value) => set('finalAction')(value as DunningFinalAction)}
            disabled={save.isPending || locked}
          />
        </View>
        <View className="flex-1 min-w-48">
          <Choice
            label={t('billing.invoiceAction')}
            value={form.invoiceAction}
            options={DUNNING_INVOICE_ACTION_OPTIONS.map((value) => ({
              value,
              label: t(`billing.invoiceAction.${value}`),
            }))}
            onChange={(value) => set('invoiceAction')(value as DunningInvoiceAction)}
            disabled={save.isPending || locked}
          />
        </View>
      </View>
      <Text variant="headline-semibold">{t('billing.emails')}</Text>
      <Toggle
        label={t('billing.emailInvoiceFinalized')}
        value={form.emailInvoiceFinalized}
        onChange={set('emailInvoiceFinalized')}
        disabled={save.isPending || locked}
      />
      <Toggle
        label={t('billing.emailPaymentFailed')}
        value={form.emailPaymentFailed}
        onChange={set('emailPaymentFailed')}
        disabled={save.isPending || locked}
      />
      <View className="flex-row justify-end">
        <Button
          appearance="solid"
          tone="accent"
          loading={save.isPending}
          disabled={locked}
          onPress={submit}
        >
          {t('action.save')}
        </Button>
      </View>
    </Section>
  );
}

function FeatureRow({ scope, feature }: { scope: DashboardScope; feature: EntitlementFeature }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const archive = useMutation({
    mutationFn: () => dashboardApi.features.update(scope, feature.id, { active: !feature.active }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: billingKeys.features(scope) }),
    onError: fail,
  });
  return (
    <View className="flex-row flex-wrap items-center gap-2 py-2 border-b border-border">
      <Badge
        appearance="subtle"
        tone={feature.active ? 'success' : 'neutral'}
        size="label-small"
        content={feature.active ? t('products.active') : t('products.archived')}
      />
      <Text variant="body-2-semibold">{feature.name}</Text>
      <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
        {feature.lookup_key}
      </Text>
      <View className="flex-1" />
      <Button
        appearance="outline"
        size="sm"
        loading={archive.isPending}
        disabled={!can('money')}
        onPress={() => archive.mutate()}
      >
        {feature.active ? t('product.archive') : t('product.unarchive')}
      </Button>
    </View>
  );
}

function Features({ scope }: { scope: DashboardScope }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const features = useFeatures(scope);
  const [form, setForm] = useState({ lookupKey: '', name: '' });
  const [invalid, setInvalid] = useState<'lookupKey' | 'name' | null>(null);
  const create = useMutation({
    mutationFn: (body: { lookup_key: string; name: string }) =>
      dashboardApi.features.create(scope, body),
    onSuccess: () => {
      toast.success(t('features.added'));
      setForm({ lookupKey: '', name: '' });
      void queryClient.invalidateQueries({ queryKey: billingKeys.features(scope) });
    },
    onError: fail,
  });
  const submit = () => {
    const result = buildFeatureBody(form);
    setInvalid(result.ok ? null : result.error);
    if (result.ok) create.mutate(result.body);
  };
  let list: React.ReactNode;
  if (features.isPending)
    list = <PageSkeleton variant="table" rows={3} accessibilityLabel={t('features.title')} />;
  else if (features.isError)
    list = <ErrorNotice error={features.error} onRetry={() => void features.refetch()} />;
  else if (features.data.data.length === 0) {
    list = (
      <EmptyState
        variant="compact"
        title={t('features.empty.title')}
        description={t('features.empty.body')}
      />
    );
  } else
    list = features.data.data.map((feature) => (
      <FeatureRow key={feature.id} scope={scope} feature={feature} />
    ));
  return (
    <Section title={t('features.title')} description={t('features.intro')}>
      {list}
      {can('money') ? (
        <>
          <View className="flex-row flex-wrap gap-4 pt-2">
            <View className="flex-1 min-w-48">
              <FormField
                label={t('features.lookupKey')}
                value={form.lookupKey}
                onChange={(lookupKey) => setForm((prior) => ({ ...prior, lookupKey }))}
                invalid={invalid === 'lookupKey'}
                hint={t('features.lookupKeyHelp')}
                disabled={create.isPending}
              />
            </View>
            <View className="flex-1 min-w-48">
              <FormField
                label={t('features.name')}
                value={form.name}
                onChange={(name) => setForm((prior) => ({ ...prior, name }))}
                autoCapitalize="sentences"
                invalid={invalid === 'name'}
                disabled={create.isPending}
              />
            </View>
          </View>
          <View className="flex-row justify-end">
            <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
              {t('features.add')}
            </Button>
          </View>
        </>
      ) : null}
    </Section>
  );
}

function BillingBody({ scope }: { scope: DashboardScope }) {
  const settings = useBillingSettings(scope);
  if (settings.isPending)
    return <PageSkeleton variant="form" accessibilityLabel={t('billing.title')} />;
  if (settings.isError) {
    if (isMerchantMissing(settings.error))
      return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  return (
    <View className="gap-6">
      <ActionPermissionNotice action="money" />
      {/* Keyed by `updated`, so a save re-seeds the form from what was stored. */}
      <SettingsEditor key={settings.data.updated} scope={scope} settings={settings.data} />
      <Features scope={scope} />
    </View>
  );
}

export default function BillingScreen() {
  return (
    <OrbitScreen title={t('billing.title')} description={t('billing.description')}>
      {({ scope }) => <BillingBody scope={scope} />}
    </OrbitScreen>
  );
}
