import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PaymentMethodConfiguration,
  PaymentMethodConfigurationType,
  PaymentMethodDomain,
} from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '../api/client';
import { isMerchantMissing, type DashboardScope } from '../api/dashboard';
import { describeError } from '../api/transport';
import { t } from '../i18n';
import { Choice } from '../ui/Choice';
import { FormField } from '../ui/FormField';
import { ErrorNotice, Section } from '../ui/OrbitScreen';
import {
  canToggle,
  currenciesText,
  defaultConfiguration,
  ORBIT_PAYMENT_METHOD_TYPES,
  parseDomainInput,
  paymentMethodLabel,
  preferenceText,
  preferenceUpdate,
  unavailableReasonText,
  walletStatusText,
} from './configuration';

const scopeKey = (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment];
const configurationKey = (scope: DashboardScope) => [
  ...scopeKey(scope),
  'payment_method_configurations',
];
const domainKey = (scope: DashboardScope) => [...scopeKey(scope), 'payment_method_domains'];

const fail = (error: unknown) => toast.error(describeError(error, t('error.generic')));

function MethodRow({
  scope,
  configuration,
  type,
}: {
  scope: DashboardScope;
  configuration: PaymentMethodConfiguration;
  type: PaymentMethodConfigurationType;
}) {
  const queryClient = useQueryClient();
  const entry = configuration[type];
  const toggle = useMutation({
    mutationFn: (on: boolean) =>
      dashboardApi.paymentMethodConfigurations.update(
        scope,
        configuration.id,
        preferenceUpdate(type, on),
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: configurationKey(scope) }),
    onError: fail,
  });
  const label = paymentMethodLabel(type);
  return (
    <View className="flex-row flex-wrap items-center gap-3 py-3 border-b border-border">
      <View className="flex-1 min-w-56 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text variant="body-2-semibold">{label}</Text>
          <Badge
            appearance="subtle"
            tone={entry.available ? 'success' : 'neutral'}
            size="label-small"
            content={entry.available ? t('methods.available') : t('methods.unavailable')}
          />
        </View>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {currenciesText(entry.currencies)} · {preferenceText(entry)}
        </Text>
        {entry.unavailable_reason ? (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {unavailableReasonText(entry.unavailable_reason)}
          </Text>
        ) : null}
      </View>
      <Switch
        accessibilityLabel={t('methods.toggle', { method: label })}
        checked={entry.display_preference.value === 'on'}
        disabled={!canToggle(entry) || toggle.isPending}
        onCheckedChange={(on) => toggle.mutate(on)}
      />
    </View>
  );
}

function ConfigurationSection({ scope }: { scope: DashboardScope }) {
  const query = useQuery({
    queryKey: configurationKey(scope),
    queryFn: () => dashboardApi.paymentMethodConfigurations.list(scope, { limit: 100 }),
  });
  const [selected, setSelected] = useState<string | null>(null);

  let body: React.ReactNode;
  if (query.isPending) body = <Loading accessibilityLabel={t('methods.title')} />;
  else if (query.isError) {
    body = isMerchantMissing(query.error) ? (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('methods.noMerchant')}
      </Text>
    ) : (
      <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />
    );
  } else {
    const configurations = query.data.data;
    const current =
      configurations.find((configuration) => configuration.id === selected) ??
      defaultConfiguration(configurations);
    body = current ? (
      <View>
        {configurations.length > 1 ? (
          <View className="w-72 pb-2">
            <Choice
              size="sm"
              label={t('methods.configuration')}
              value={current.id}
              options={configurations.map((configuration) => ({
                value: configuration.id,
                label: configuration.is_default
                  ? t('methods.defaultName', { name: configuration.name })
                  : configuration.name,
              }))}
              onChange={setSelected}
            />
          </View>
        ) : null}
        {!current.active ? (
          <Text variant="caption-1-regular" className="text-muted-foreground pb-2">
            {t('methods.inactive')}
          </Text>
        ) : null}
        {ORBIT_PAYMENT_METHOD_TYPES.map((type) => (
          <MethodRow key={type} scope={scope} configuration={current} type={type} />
        ))}
      </View>
    ) : (
      <EmptyState variant="compact" title={t('methods.none')} />
    );
  }

  return (
    <Section title={t('methods.title')} description={t('methods.intro')}>
      {body}
    </Section>
  );
}

function DomainRow({ scope, domain }: { scope: DashboardScope; domain: PaymentMethodDomain }) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: domainKey(scope) });
  const toggle = useMutation({
    mutationFn: () =>
      dashboardApi.paymentMethodDomains.update(scope, domain.id, { enabled: !domain.enabled }),
    onSuccess: refresh,
    onError: fail,
  });
  const validate = useMutation({
    mutationFn: () => dashboardApi.paymentMethodDomains.validate(scope, domain.id),
    onSuccess: () => {
      toast.success(t('domains.validated'));
      refresh();
    },
    onError: fail,
  });
  return (
    <View className="gap-1 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge
          appearance="subtle"
          tone={domain.enabled ? 'success' : 'neutral'}
          size="label-small"
          content={domain.enabled ? t('domains.enabled') : t('domains.disabled')}
        />
        <Text variant="body-2-semibold" selectable className="font-mono flex-1 min-w-56">
          {domain.domain_name}
        </Text>
      </View>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        Apple Pay: {walletStatusText(domain.apple_pay)}
      </Text>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        Google Pay: {walletStatusText(domain.google_pay)}
      </Text>
      <View className="flex-row flex-wrap gap-2 pt-1">
        <Button
          appearance="outline"
          size="sm"
          loading={validate.isPending}
          onPress={() => validate.mutate()}
        >
          {t('domains.validate')}
        </Button>
        <Button
          appearance="outline"
          size="sm"
          loading={toggle.isPending}
          onPress={() => toggle.mutate()}
        >
          {domain.enabled ? t('domains.disable') : t('domains.enable')}
        </Button>
      </View>
    </View>
  );
}

function AddDomain({ scope }: { scope: DashboardScope }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (domain: string) =>
      dashboardApi.paymentMethodDomains.create(scope, { domain_name: domain }),
    onSuccess: () => {
      setInput('');
      toast.success(t('domains.added'));
      void queryClient.invalidateQueries({ queryKey: domainKey(scope) });
    },
    onError: fail,
  });
  const submit = () => {
    const parsed = parseDomainInput(input);
    if (!parsed.ok) {
      setProblem(parsed.message);
      return;
    }
    setProblem(null);
    create.mutate(parsed.domain);
  };
  return (
    <View className="flex-row flex-wrap items-end gap-3 pt-2">
      <View className="flex-1 min-w-64">
        <FormField
          label={t('domains.add')}
          value={input}
          onChange={setInput}
          placeholder="shop.example.com"
          hint={problem ?? t('domains.addHelp')}
          invalid={problem !== null}
          disabled={create.isPending}
        />
      </View>
      <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
        {t('domains.addAction')}
      </Button>
    </View>
  );
}

function DomainsSection({ scope }: { scope: DashboardScope }) {
  const query = useQuery({
    queryKey: domainKey(scope),
    queryFn: () => dashboardApi.paymentMethodDomains.list(scope, { limit: 100 }),
  });
  let body: React.ReactNode;
  if (query.isPending) body = <Loading accessibilityLabel={t('domains.title')} />;
  else if (query.isError) {
    body = isMerchantMissing(query.error) ? (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('methods.noMerchant')}
      </Text>
    ) : (
      <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />
    );
  } else {
    body = (
      <View>
        {query.data.data.length ? (
          query.data.data.map((domain) => (
            <DomainRow key={domain.id} scope={scope} domain={domain} />
          ))
        ) : (
          <Text variant="body-2-regular" className="text-muted-foreground">
            {t('domains.none')}
          </Text>
        )}
        <AddDomain scope={scope} />
      </View>
    );
  }
  return (
    <Section title={t('domains.title')} description={t('domains.intro')}>
      {body}
    </Section>
  );
}

/** Settings → Payment methods: which methods payers are offered, and where wallets run. */
export function PaymentMethodsSettings({ scope }: { scope: DashboardScope }) {
  return (
    <View className="gap-6">
      <ConfigurationSection scope={scope} />
      <DomainsSection scope={scope} />
    </View>
  );
}
