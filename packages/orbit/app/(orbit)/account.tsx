import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Account } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { OXY_AUTH_REDIRECT_URI } from '@/config';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import {
  buildCreateAccountBody,
  type CreateAccountForm,
  EMPTY_CREATE_ACCOUNT_FORM,
  onboardingLinkBody,
  originOf,
} from '@/money/forms';
import {
  disabledReasonLabel,
  onboardingAction,
  REQUIREMENT_GROUPS,
  requirementLabels,
  requirementsClear,
} from '@/money/requirements';
import { moneyKeys, useAccount } from '@/money/useMoney';
import { modeForEnvironment } from '@/scope/scope';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, Field, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { CapabilityBadge, EnabledBadge } from '@/ui/StatusBadge';

const modeLabel = (scope: DashboardScope) =>
  t(modeForEnvironment(scope.environment) === 'live' ? 'scope.live' : 'scope.test');

/** Where the provider sends the merchant back to: this page, on the origin Orbit runs at. */
function orbitOrigin(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return originOf(OXY_AUTH_REDIRECT_URI);
}

/** The hosted page replaces Orbit in a browser; elsewhere it opens in the system browser. */
async function openOnboarding(url: string): Promise<void> {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.assign(url);
    return;
  }
  await Linking.openURL(url);
}

function CreateAccount({ scope }: { scope: DashboardScope }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateAccountForm>(EMPTY_CREATE_ACCOUNT_FORM);
  const [invalid, setInvalid] = useState(false);
  const create = useMutation({
    mutationFn: (body: Parameters<typeof dashboardApi.account.update>[1]) =>
      dashboardApi.account.update(scope, body),
    onSuccess: (account) => {
      queryClient.setQueryData(moneyKeys.account(scope), account);
      // The balance and payouts were answering "no account".
      void queryClient.invalidateQueries({ queryKey: moneyKeys.all(scope) });
      toast.success(t('account.create.created'));
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  const submit = () => {
    const result = buildCreateAccountBody(form);
    setInvalid(!result.ok);
    if (result.ok) create.mutate(result.body);
  };
  const busy = create.isPending;
  return (
    <Section
      title={t('account.create.title')}
      description={t('account.create.intro', { mode: modeLabel(scope) })}
    >
      <FormField
        label={t('account.create.country')}
        value={form.country}
        onChange={(country) => setForm((prior) => ({ ...prior, country }))}
        hint={invalid ? t('account.create.invalid.country') : t('account.create.countryHelp')}
        invalid={invalid}
        autoCapitalize="characters"
        placeholder="ES"
        disabled={busy}
      />
      <View className="gap-1.5">
        <Text variant="caption-1-medium" className="text-muted-foreground">
          {t('account.create.businessType')}
        </Text>
        <SegmentedControl<CreateAccountForm['businessType']>
          label={t('account.create.businessType')}
          type="radio"
          size="sm"
          value={form.businessType}
          disabled={busy}
          onValueChange={(businessType) => setForm((prior) => ({ ...prior, businessType }))}
        >
          <SegmentedControlItem value="company">
            <SegmentedControlItemText>{t('account.create.company')}</SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem value="individual">
            <SegmentedControlItemText>{t('account.create.individual')}</SegmentedControlItemText>
          </SegmentedControlItem>
        </SegmentedControl>
      </View>
      <View className="flex-row justify-end">
        <Button appearance="solid" tone="accent" loading={busy} onPress={submit}>
          {t('account.create.submit')}
        </Button>
      </View>
    </Section>
  );
}

function Onboarding({ scope, account }: { scope: DashboardScope; account: Account }) {
  const action = onboardingAction(account);
  const link = useMutation({
    // Minted on the click and opened at once: a stored link is one that expired.
    mutationFn: () => dashboardApi.account.createLink(scope, onboardingLinkBody(orbitOrigin())),
    onSuccess: (created) => openOnboarding(created.url),
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  return (
    <Section title={t('account.onboarding')} description={t('account.onboarding.help')}>
      <View className="flex-row">
        <Button
          appearance={action === 'update' ? 'outline' : 'solid'}
          tone="accent"
          loading={link.isPending}
          onPress={() => link.mutate()}
        >
          {t(`account.onboarding.${action}`)}
        </Button>
      </View>
    </Section>
  );
}

function RequirementList({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <Field
      label={label}
      value={
        <View className="gap-1">
          {requirementLabels(items).map((item) => (
            <Text key={item} variant="body-2-regular">
              {`• ${item}`}
            </Text>
          ))}
        </View>
      }
    />
  );
}

function Requirements({ account }: { account: Account }) {
  const { requirements } = account;
  const reason = disabledReasonLabel(requirements.disabled_reason);
  return (
    <Section title={t('account.requirements')} description={t('account.requirementsIntro')}>
      {requirementsClear(requirements) ? (
        <Text variant="body-2-regular" className="text-muted-foreground">
          {t('account.requirements.allClear')}
        </Text>
      ) : (
        <View>
          {reason ? (
            <Field
              label={t('account.requirements.disabledReason')}
              value={
                <View className="gap-0.5">
                  <Text variant="body-2-semibold">{reason}</Text>
                  <Text variant="caption-1-regular" selectable className="font-mono">
                    {requirements.disabled_reason}
                  </Text>
                </View>
              }
            />
          ) : null}
          {REQUIREMENT_GROUPS.filter((group) => requirements[group].length > 0).map((group) => (
            <RequirementList
              key={group}
              label={t(`account.requirements.${group}`)}
              items={requirements[group]}
            />
          ))}
        </View>
      )}
    </Section>
  );
}

function AccountDetail({ scope, account }: { scope: DashboardScope; account: Account }) {
  const notSet = t('account.notSet');
  const profile = account.business_profile;
  return (
    <View className="gap-6">
      <Section title={t('account.status')}>
        <Field
          label={t('account.charges')}
          value={<EnabledBadge enabled={account.charges_enabled} />}
        />
        <Field
          label={t('account.payouts')}
          value={<EnabledBadge enabled={account.payouts_enabled} />}
        />
        <Field label={t('account.id')} value={account.id} mono />
        <Field label={t('account.country')} value={account.country} />
        <Field
          label={t('account.defaultCurrency')}
          value={account.default_currency?.toUpperCase() ?? notSet}
        />
        <Field
          label={t('account.lastSynced')}
          value={
            account.last_synced_at === null
              ? t('account.never')
              : formatInstant(account.last_synced_at)
          }
        />
      </Section>
      <Onboarding scope={scope} account={account} />
      <Requirements account={account} />
      <Section title={t('account.capabilities')}>
        <Field
          label={t('account.capability.card_payments')}
          value={<CapabilityBadge status={account.capabilities.card_payments} />}
        />
        <Field
          label={t('account.capability.transfers')}
          value={<CapabilityBadge status={account.capabilities.transfers} />}
        />
      </Section>
      <Section title={t('account.businessProfile')}>
        <Field label={t('account.profile.name')} value={profile.name ?? notSet} />
        <Field label={t('account.profile.url')} value={profile.url ?? notSet} />
        <Field label={t('account.profile.supportEmail')} value={profile.support_email ?? notSet} />
        <Field label={t('account.profile.supportUrl')} value={profile.support_url ?? notSet} />
        <Field
          label={t('account.profile.productDescription')}
          value={profile.product_description ?? notSet}
        />
        <Field label={t('account.profile.mcc')} value={profile.mcc ?? notSet} mono />
        <Field
          label={t('account.statementDescriptor')}
          value={account.settings.payments.statement_descriptor ?? notSet}
          mono
        />
        <Field
          label={t('account.payoutDescriptor')}
          value={account.settings.payouts.statement_descriptor ?? notSet}
          mono
        />
      </Section>
    </View>
  );
}

function AccountLoader({ scope }: { scope: DashboardScope }) {
  const query = useAccount(scope);
  if (query.isPending) return <Loading accessibilityLabel={t('account.title')} />;
  if (query.isError) {
    if (isMerchantMissing(query.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.data === null) return <CreateAccount scope={scope} />;
  return <AccountDetail scope={scope} account={query.data} />;
}

export default function AccountScreen() {
  return (
    <OrbitScreen title={t('account.title')} description={t('account.description')}>
      {({ scope }) => (
        // Keyed by scope so a mode switch reads that mode's account, never this one.
        <AccountLoader key={`${scope.applicationId}:${scope.environment}`} scope={scope} />
      )}
    </OrbitScreen>
  );
}
