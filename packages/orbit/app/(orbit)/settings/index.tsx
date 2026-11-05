import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Merchant } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import {
  buildMerchantPatch,
  buildRegisterBody,
  emptyMerchantForm,
  formFromMerchant,
  type MerchantForm,
} from '@/merchant/form';
import {
  buildFaircoinKeyBody,
  emptyFaircoinKeyForm,
  faircoinKeyFormErrorKey,
  faircoinKeyRefusalKey,
  faircoinKeyStatus,
  type FaircoinKeyForm,
  type FaircoinKeyFormError,
  networksFor,
} from '@/merchant/faircoinKey';
import { PaymentMethodsSettings } from '@/paymentMethods/PaymentMethodsSettings';
import { modeForEnvironment } from '@/scope/scope';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { FormField } from '@/ui/FormField';
import { LanguageSettings } from '@/ui/LanguageSettings';
import { ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { FaircoinKeyRequired, PermissionNotice, PageSkeleton } from '@/ui/states';
import { merchantQueryKey } from '@/merchant/useMerchant';

const merchantKey = merchantQueryKey;

const modeLabel = (scope: DashboardScope) =>
  t(modeForEnvironment(scope.environment) === 'live' ? 'scope.live' : 'scope.test');

/** The checkout look and customer emails live on their own screen. */
function BrandingPointer() {
  const router = useRouter();
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('settings.brandingPointer')}
      </Text>
      <LinkButton size="sm" onPress={() => router.push('/branding')}>
        {t('settings.brandingOpen')}
      </LinkButton>
    </View>
  );
}

function MerchantFields({
  form,
  setForm,
  busy,
  registering,
  invalidConfirmations,
  environment,
}: {
  form: MerchantForm;
  setForm: (update: (prior: MerchantForm) => MerchantForm) => void;
  busy: boolean;
  registering: boolean;
  invalidConfirmations: boolean;
  environment: DashboardScope['environment'];
}) {
  const set = (field: keyof MerchantForm) => (value: string) =>
    setForm((prior) => ({ ...prior, [field]: value }));
  return (
    <View className="gap-6">
      <View className="gap-4">
        <Text variant="body-semibold">{t('settings.branding')}</Text>
        <BrandingPointer />
        <FormField
          label={t('settings.displayName')}
          value={form.displayName}
          onChange={set('displayName')}
          autoCapitalize="words"
          disabled={busy}
        />
        <FormField
          label={t('settings.description')}
          value={form.description}
          onChange={set('description')}
          autoCapitalize="sentences"
          multiline
          disabled={busy}
        />
      </View>
      <View className="gap-4">
        <Text variant="body-semibold">{t('settings.faircoin')}</Text>
        {registering ? (
          <>
            <View className="flex-row flex-wrap items-center gap-2">
              <Text variant="body-2-semibold">{t('settings.faircoinKey.title')}</Text>
              <Badge
                appearance="subtle"
                tone="warning"
                size="label-small"
                content={t('settings.faircoinKey.required')}
              />
            </View>
            <Text variant="caption-1-regular" className="text-muted-foreground">
              {t('settings.faircoinKey.intro')}
            </Text>
            <View className="gap-1.5">
              <Text variant="caption-1-medium" className="text-muted-foreground">
                {t('settings.network')}
              </Text>
              <SegmentedControl<MerchantForm['network']>
                label={t('settings.network')}
                type="radio"
                size="sm"
                value={form.network}
                disabled={busy}
                onValueChange={(network) => setForm((prior) => ({ ...prior, network }))}
              >
                {[...networksFor(environment)].map((network) => (
                  <SegmentedControlItem key={network} value={network}>
                    <SegmentedControlItemText>{network}</SegmentedControlItemText>
                  </SegmentedControlItem>
                ))}
                <SegmentedControlItem value="none">
                  <SegmentedControlItemText>{t('settings.faircoinLater')}</SegmentedControlItemText>
                </SegmentedControlItem>
              </SegmentedControl>
            </View>
            {form.network !== 'none' ? (
              <FormField
                label={t('settings.xpub')}
                value={form.xpub}
                onChange={set('xpub')}
                hint={t('settings.xpubHelp')}
                disabled={busy}
              />
            ) : (
              <Text variant="caption-1-regular" className="text-muted-foreground">
                {t(
                  environment === 'production'
                    ? 'settings.faircoinLaterLive'
                    : 'settings.faircoinLaterTest',
                )}
              </Text>
            )}
          </>
        ) : null}
        <FormField
          label={t('settings.confirmations')}
          value={form.requiredConfirmations}
          onChange={set('requiredConfirmations')}
          hint={
            invalidConfirmations
              ? t('settings.invalidConfirmations')
              : t('settings.confirmationsHelp')
          }
          invalid={invalidConfirmations}
          keyboardType="number-pad"
          disabled={busy}
        />
      </View>
    </View>
  );
}

/**
 * Register the merchant's FairCoin receiving key ONCE (ADR 0021 D5), for a
 * merchant that registered without one. Watch-only: Peable derives receive
 * addresses from it and can never spend. Immutable once registered, so the
 * last step asks for an explicit confirmation.
 */
function FaircoinKeySettings({ scope, merchant }: { scope: DashboardScope; merchant: Merchant }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const allowed = can('money');
  const live = faircoinKeyStatus(merchant) === 'required_live';
  const networks = networksFor(scope.environment);
  const [form, setForm] = useState<FaircoinKeyForm>(emptyFaircoinKeyForm(scope.environment));
  const [formError, setFormError] = useState<FaircoinKeyFormError | null>(null);
  const [confirming, setConfirming] = useState(false);

  const register = useMutation({
    mutationFn: async () => {
      const built = buildFaircoinKeyBody(form, scope.environment);
      if (!built.ok) throw new Error(t(faircoinKeyFormErrorKey(built.error)));
      return dashboardApi.merchant.registerFaircoinKey(scope, built.body);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(merchantKey(scope), saved);
      // Every create that answered `faircoin_account_required` may now succeed.
      void queryClient.invalidateQueries({
        queryKey: ['orbit', scope.applicationId, scope.environment],
      });
      toast.success(t('settings.faircoinKey.registered'));
    },
    onError: (error) => {
      setConfirming(false);
      const refusal = faircoinKeyRefusalKey(error);
      toast.error(refusal ? t(refusal) : describeError(error, t('error.generic')));
    },
  });

  const review = () => {
    const built = buildFaircoinKeyBody(form, scope.environment);
    setFormError(built.ok ? null : built.error);
    setConfirming(built.ok);
  };

  return (
    <Section
      title={t('settings.faircoinKey.title')}
      description={t('settings.faircoinKey.intro')}
      actions={
        <Badge
          appearance="subtle"
          tone={live ? 'danger' : 'warning'}
          size="label-small"
          content={t('settings.faircoinKey.required')}
        />
      }
    >
      {live ? <FaircoinKeyRequired /> : null}
      {!live ? (
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {t('settings.faircoinKey.testNote')}
        </Text>
      ) : null}
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('settings.faircoinKey.watchOnly')}
      </Text>
      <PermissionNotice action="money" />
      <View className="gap-1.5">
        <Text variant="caption-1-medium" className="text-muted-foreground">
          {t('settings.network')}
        </Text>
        <SegmentedControl<FaircoinKeyForm['network']>
          label={t('settings.network')}
          type="radio"
          size="sm"
          value={form.network}
          disabled={register.isPending || !allowed || confirming}
          onValueChange={(network) => setForm((prior) => ({ ...prior, network }))}
        >
          {networks.map((network) => (
            <SegmentedControlItem key={network} value={network}>
              <SegmentedControlItemText>{network}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </View>
      <FormField
        label={t('settings.xpub')}
        value={form.xpub}
        onChange={(xpub) => {
          setForm((prior) => ({ ...prior, xpub }));
          setFormError(null);
        }}
        hint={formError ? t(faircoinKeyFormErrorKey(formError)) : t('settings.xpubHelp')}
        invalid={formError !== null}
        disabled={register.isPending || !allowed || confirming}
      />
      {confirming ? (
        <View className="gap-3">
          <Text variant="body-2-semibold">{t('settings.faircoinKey.confirm')}</Text>
          <View className="flex-row flex-wrap justify-end gap-2">
            <Button
              appearance="outline"
              disabled={register.isPending}
              onPress={() => setConfirming(false)}
            >
              {t('action.cancel')}
            </Button>
            <Button
              appearance="solid"
              tone="accent"
              loading={register.isPending}
              disabled={!allowed}
              onPress={() => register.mutate()}
            >
              {t('settings.faircoinKey.confirmAction')}
            </Button>
          </View>
        </View>
      ) : (
        <View className="flex-row justify-end pt-2">
          <Button appearance="solid" tone="accent" disabled={!allowed} onPress={review}>
            {t('settings.faircoinKey.register')}
          </Button>
        </View>
      )}
    </Section>
  );
}

function MerchantSettings({
  scope,
  merchant,
}: {
  scope: DashboardScope;
  merchant: Merchant | null;
}) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const allowed = can('money');
  const [form, setForm] = useState<MerchantForm>(
    merchant ? formFromMerchant(merchant) : emptyMerchantForm(scope.environment),
  );
  const [invalidConfirmations, setInvalidConfirmations] = useState(false);

  // A saved merchant resets the form to what the gateway now holds.
  useEffect(() => {
    setForm(merchant ? formFromMerchant(merchant) : emptyMerchantForm(scope.environment));
    setInvalidConfirmations(false);
  }, [merchant, scope.environment]);

  const save = useMutation({
    mutationFn: async () => {
      if (merchant) {
        const patch = buildMerchantPatch(merchant, form);
        if (!patch.ok) throw new Error(t('settings.invalidConfirmations'));
        if (!Object.keys(patch.body).length) return merchant;
        return dashboardApi.merchant.update(scope, patch.body);
      }
      const register = buildRegisterBody(form);
      if (!register.ok) throw new Error(t('settings.invalidConfirmations'));
      return dashboardApi.merchant.register(scope, register.body);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(merchantKey(scope), saved);
      // Every merchant-scoped list may have been answering "no merchant".
      void queryClient.invalidateQueries({
        queryKey: ['orbit', scope.applicationId, scope.environment],
      });
      toast.success(merchant ? t('settings.saved') : t('settings.registered'));
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });

  const submit = () => {
    const valid = merchant ? buildMerchantPatch(merchant, form).ok : buildRegisterBody(form).ok;
    setInvalidConfirmations(!valid);
    if (valid) save.mutate();
  };

  return (
    <View className="gap-6">
      {merchant ? (
        <Section
          title={t('settings.merchant')}
          description={t('settings.merchantIntro', { mode: modeLabel(scope) })}
        >
          <Field label={t('settings.merchantId')} value={merchant.id} mono />
          <Field label={t('settings.environment')} value={merchant.environment} />
          <Field
            label={t('settings.network')}
            value={merchant.network ?? t('settings.faircoinKey.notRegistered')}
          />
          {merchant.xpub ? (
            <Field
              label={t('settings.faircoinKey.title')}
              value={`${merchant.xpub} · ${t('settings.faircoinKey.immutable')}`}
              mono
            />
          ) : null}
          <Field label={t('settings.created')} value={formatInstant(merchant.created)} />
        </Section>
      ) : null}
      {merchant && faircoinKeyStatus(merchant) !== 'registered' ? (
        <FaircoinKeySettings scope={scope} merchant={merchant} />
      ) : null}
      <Section
        title={merchant ? undefined : t('settings.register')}
        description={merchant ? undefined : t('settings.registerIntro', { mode: modeLabel(scope) })}
      >
        <PermissionNotice action="money" />
        <MerchantFields
          form={form}
          setForm={setForm}
          busy={save.isPending || !allowed}
          registering={!merchant}
          invalidConfirmations={invalidConfirmations}
          environment={scope.environment}
        />
        <View className="flex-row justify-end pt-2">
          <Button
            appearance="solid"
            tone="accent"
            loading={save.isPending}
            disabled={!allowed}
            onPress={submit}
          >
            {merchant ? t('action.save') : t('settings.register')}
          </Button>
        </View>
      </Section>
      {merchant ? <PaymentMethodsSettings scope={scope} /> : null}
    </View>
  );
}

function MerchantLoader({ scope }: { scope: DashboardScope }) {
  const query = useQuery({
    queryKey: merchantKey(scope),
    queryFn: () => dashboardApi.merchant.retrieve(scope),
  });
  if (query.isPending)
    return <PageSkeleton variant="form" accessibilityLabel={t('settings.merchant')} />;
  if (query.isError) {
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <MerchantSettings scope={scope} merchant={query.data} />;
}

/** Business details and Team are pages of their own under Settings. */
function MoreSettings() {
  const router = useRouter();
  return (
    <Section title={t('settings.more')}>
      <View className="flex-row flex-wrap gap-2">
        <Button appearance="outline" size="sm" onPress={() => router.push('/settings/business')}>
          {t('settings.business.open')}
        </Button>
        <Button appearance="outline" size="sm" onPress={() => router.push('/settings/team')}>
          {t('settings.team.open')}
        </Button>
      </View>
    </Section>
  );
}

export default function SettingsScreen() {
  return (
    <OrbitScreen title={t('settings.title')} merchant="optional">
      {({ scope }) => (
        <View className="gap-6">
          <MoreSettings />
          {/* Keyed by scope so a mode or application switch starts from that merchant's values. */}
          <MerchantLoader key={`${scope.applicationId}:${scope.environment}`} scope={scope} />
          <LanguageSettings />
        </View>
      )}
    </OrbitScreen>
  );
}
