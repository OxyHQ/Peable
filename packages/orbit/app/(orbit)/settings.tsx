import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Merchant } from '@peable.to/shared-types';
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
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import {
  buildMerchantPatch,
  buildRegisterBody,
  EMPTY_MERCHANT_FORM,
  formFromMerchant,
  type MerchantForm,
} from '@/merchant/form';
import { PaymentMethodsSettings } from '@/paymentMethods/PaymentMethodsSettings';
import { modeForEnvironment } from '@/scope/scope';
import { FileUploadField } from '@/ui/FileUploadField';
import { FormField } from '@/ui/FormField';
import { ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';

const merchantKey = (scope: DashboardScope) => [
  'orbit',
  scope.applicationId,
  scope.environment,
  'merchant',
];

const modeLabel = (scope: DashboardScope) =>
  t(modeForEnvironment(scope.environment) === 'live' ? 'scope.live' : 'scope.test');

function MerchantFields({
  form,
  setForm,
  busy,
  registering,
  invalidConfirmations,
}: {
  form: MerchantForm;
  setForm: (update: (prior: MerchantForm) => MerchantForm) => void;
  busy: boolean;
  registering: boolean;
  invalidConfirmations: boolean;
}) {
  const set = (field: keyof MerchantForm) => (value: string) =>
    setForm((prior) => ({ ...prior, [field]: value }));
  return (
    <View className="gap-6">
      <View className="gap-4">
        <Text variant="body-semibold">{t('settings.branding')}</Text>
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
                <SegmentedControlItem value="none">
                  <SegmentedControlItemText>{t('settings.cardOnly')}</SegmentedControlItemText>
                </SegmentedControlItem>
                <SegmentedControlItem value="testnet">
                  <SegmentedControlItemText>testnet</SegmentedControlItemText>
                </SegmentedControlItem>
                <SegmentedControlItem value="mainnet">
                  <SegmentedControlItemText>mainnet</SegmentedControlItemText>
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
            ) : null}
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
 * The wordmark payer surfaces show in their header (`business_logo`), beside —
 * never instead of — the avatar. Uploaded as a `business_logo` file, then set
 * on the merchant.
 */
function LogoSettings({ scope, merchant }: { scope: DashboardScope; merchant: Merchant }) {
  const queryClient = useQueryClient();
  const setLogo = useMutation({
    mutationFn: (fileId: string | null) =>
      dashboardApi.merchant.update(scope, { business_logo: fileId }),
    onSuccess: (saved) => {
      queryClient.setQueryData(merchantKey(scope), saved);
      toast.success(saved.business_logo ? t('settings.logo.saved') : t('settings.logo.removed'));
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  return (
    <Section title={t('settings.logo')} description={t('settings.logo.intro')}>
      <Field
        label={t('settings.logo.current')}
        value={merchant.business_logo ?? t('settings.logo.none')}
        mono={merchant.business_logo !== undefined}
      />
      <FileUploadField
        scope={scope}
        purpose="business_logo"
        label={t('settings.logo.upload')}
        disabled={setLogo.isPending}
        onUploaded={(file) => setLogo.mutate(file.id)}
      />
      {merchant.business_logo ? (
        <View className="flex-row justify-end">
          <Button
            appearance="outline"
            size="sm"
            loading={setLogo.isPending}
            onPress={() => setLogo.mutate(null)}
          >
            {t('settings.logo.remove')}
          </Button>
        </View>
      ) : null}
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
  const [form, setForm] = useState<MerchantForm>(
    merchant ? formFromMerchant(merchant) : EMPTY_MERCHANT_FORM,
  );
  const [invalidConfirmations, setInvalidConfirmations] = useState(false);

  // A saved merchant resets the form to what the gateway now holds.
  useEffect(() => {
    setForm(merchant ? formFromMerchant(merchant) : EMPTY_MERCHANT_FORM);
    setInvalidConfirmations(false);
  }, [merchant]);

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
          <Field label={t('settings.network')} value={merchant.network ?? t('settings.cardOnly')} />
          {merchant.xpub ? <Field label={t('settings.xpub')} value={merchant.xpub} mono /> : null}
          <Field label={t('settings.created')} value={formatInstant(merchant.created)} />
        </Section>
      ) : null}
      <Section
        title={merchant ? undefined : t('settings.register')}
        description={merchant ? undefined : t('settings.registerIntro', { mode: modeLabel(scope) })}
      >
        <MerchantFields
          form={form}
          setForm={setForm}
          busy={save.isPending}
          registering={!merchant}
          invalidConfirmations={invalidConfirmations}
        />
        <View className="flex-row justify-end pt-2">
          <Button appearance="solid" tone="accent" loading={save.isPending} onPress={submit}>
            {merchant ? t('action.save') : t('settings.register')}
          </Button>
        </View>
      </Section>
      {merchant ? <LogoSettings scope={scope} merchant={merchant} /> : null}
      {merchant ? <PaymentMethodsSettings scope={scope} /> : null}
    </View>
  );
}

function MerchantLoader({ scope }: { scope: DashboardScope }) {
  const query = useQuery({
    queryKey: merchantKey(scope),
    queryFn: () => dashboardApi.merchant.retrieve(scope),
  });
  if (query.isPending) return <Loading accessibilityLabel={t('settings.merchant')} />;
  if (query.isError) {
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <MerchantSettings scope={scope} merchant={query.data} />;
}

export default function SettingsScreen() {
  return (
    <OrbitScreen title={t('settings.title')}>
      {({ scope }) => (
        // Keyed by scope so a mode or application switch starts from that merchant's values.
        <MerchantLoader key={`${scope.applicationId}:${scope.environment}`} scope={scope} />
      )}
    </OrbitScreen>
  );
}
