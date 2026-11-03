import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MerchantBranding,
  MerchantEmailSettings,
  UpdateMerchantBrandingParams,
  UpdateMerchantEmailSettingsParams,
} from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { BrandingPreview } from '@/branding/BrandingPreview';
import {
  type BrandingForm,
  type BrandingFormError,
  brandingFormOf,
  brandingPreview,
  buildBrandingPatch,
  buildEmailSettingsPatch,
  type EmailSettingsForm,
  emailSettingsFormOf,
  ORBIT_BORDER_STYLES,
  ORBIT_BRANDING_FONTS,
} from '@/branding/brandingForm';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { FileUploadField } from '@/ui/FileUploadField';
import { FormField } from '@/ui/FormField';
import { ActionPermissionNotice } from '@/ui/ActionPermissionNotice';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { Toggle } from '@/ui/Toggle';
import { PageSkeleton } from '@/ui/states';
import { merchantQueryKey } from '@/merchant/useMerchant';

const DEFAULT = 'default';

const fontOptions = () => [
  { value: DEFAULT, label: t('branding.default') },
  ...ORBIT_BRANDING_FONTS.map((value) => ({ value, label: t(`branding.font.${value}`) })),
];
const borderOptions = () => [
  { value: DEFAULT, label: t('branding.default') },
  ...ORBIT_BORDER_STYLES.map((value) => ({ value, label: t(`branding.border.${value}`) })),
];

const settingsKey = (scope: DashboardScope, which: 'branding' | 'email_settings') => [
  'orbit',
  scope.applicationId,
  scope.environment,
  which,
];

const fail = (error: unknown) => toast.error(describeError(error, t('error.generic')));

function BrandingEditor({
  scope,
  branding,
  merchantName,
}: {
  scope: DashboardScope;
  branding: MerchantBranding;
  merchantName: string;
}) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const [form, setForm] = useState<BrandingForm>(() => brandingFormOf(branding));
  const [invalid, setInvalid] = useState<BrandingFormError[]>([]);
  const save = useMutation({
    mutationFn: (body: UpdateMerchantBrandingParams) => dashboardApi.branding.update(scope, body),
    onSuccess: (saved) => {
      queryClient.setQueryData(settingsKey(scope, 'branding'), saved);
      setForm(brandingFormOf(saved));
      toast.success(t('branding.saved'));
    },
    onError: fail,
  });
  const set =
    <K extends keyof BrandingForm>(key: K) =>
    (value: BrandingForm[K]) =>
      setForm((prior) => ({ ...prior, [key]: value }));
  const submit = () => {
    const result = buildBrandingPatch(branding, form);
    setInvalid(result.ok ? [] : result.errors);
    if (!result.ok) return;
    if (Object.keys(result.body).length === 0) {
      toast.success(t('branding.nothingChanged'));
      return;
    }
    save.mutate(result.body);
  };
  const busy = save.isPending || !can('configure');
  const preview = brandingPreview(form);
  return (
    <Section title={t('branding.title')} description={t('branding.intro')}>
      <View className="flex-row flex-wrap gap-6">
        <View className="flex-1 min-w-72 gap-4">
          <Toggle
            label={t('branding.useAvatar')}
            hint={t('branding.useAvatarHelp')}
            value={form.useAvatarAsIcon}
            onChange={set('useAvatarAsIcon')}
            disabled={busy}
          />
          <View className="gap-2">
            <Text variant="body-medium">{t('branding.logo')}</Text>
            <Text variant="caption-1-regular" className="text-muted-foreground">
              {form.logo ? form.logo : t('branding.logo.none')}
            </Text>
            {invalid.includes('logo') ? (
              <Text variant="caption-1-regular" className="text-destructive">
                {t('branding.logo.invalid')}
              </Text>
            ) : null}
            {/* The logo is the merchant's `business_logo` File: uploaded with
                its purpose, then saved with the rest of the branding. */}
            <FileUploadField
              scope={scope}
              purpose="business_logo"
              label={t('branding.logo.upload')}
              disabled={busy}
              onUploaded={(file) => set('logo')(file.id)}
            />
            {form.logo ? (
              <View className="flex-row">
                <Button
                  appearance="plain"
                  size="sm"
                  disabled={busy}
                  onPress={() => set('logo')('')}
                >
                  {t('branding.logo.remove')}
                </Button>
              </View>
            ) : null}
          </View>
          <FormField
            label={t('branding.termsUrl')}
            value={form.termsOfServiceUrl}
            onChange={set('termsOfServiceUrl')}
            keyboardType="url"
            placeholder="https://example.com/terms"
            invalid={invalid.includes('terms_of_service_url')}
            hint={
              invalid.includes('terms_of_service_url')
                ? t('branding.termsUrlInvalid')
                : t('branding.termsUrlHelp')
            }
            disabled={busy}
          />
          <View className="flex-row flex-wrap gap-4">
            <View className="flex-1 min-w-40">
              <FormField
                label={t('branding.primaryColor')}
                value={form.primaryColor}
                onChange={set('primaryColor')}
                placeholder="#1f6feb"
                invalid={invalid.includes('primary_color')}
                hint={
                  invalid.includes('primary_color')
                    ? t('branding.colorInvalid')
                    : t('branding.colorHelp')
                }
                disabled={busy}
              />
            </View>
            <View className="flex-1 min-w-40">
              <FormField
                label={t('branding.accentColor')}
                value={form.accentColor}
                onChange={set('accentColor')}
                placeholder="#0b1f33"
                invalid={invalid.includes('accent_color')}
                hint={
                  invalid.includes('accent_color')
                    ? t('branding.colorInvalid')
                    : t('branding.colorHelp')
                }
                disabled={busy}
              />
            </View>
          </View>
          <View className="flex-row flex-wrap gap-4">
            <View className="flex-1 min-w-40">
              <Choice
                label={t('branding.font')}
                value={form.font ?? DEFAULT}
                options={fontOptions()}
                onChange={(value) =>
                  set('font')(value === DEFAULT ? null : (value as BrandingForm['font']))
                }
                disabled={busy}
              />
            </View>
            <View className="flex-1 min-w-40">
              <Choice
                label={t('branding.borderStyle')}
                value={form.borderStyle ?? DEFAULT}
                options={borderOptions()}
                onChange={(value) =>
                  set('borderStyle')(
                    value === DEFAULT ? null : (value as BrandingForm['borderStyle']),
                  )
                }
                disabled={busy}
              />
            </View>
          </View>
        </View>
        <View className="gap-2 min-w-72">
          <Text variant="caption-1-medium" className="text-muted-foreground">
            {t('branding.preview')}
          </Text>
          <BrandingPreview preview={preview} merchantName={merchantName} />
          <Text variant="caption-1-regular" className="text-muted-foreground max-w-[420px]">
            {t('branding.previewHelp')}
          </Text>
        </View>
      </View>
      <View className="flex-row justify-end">
        <Button
          appearance="solid"
          tone="accent"
          loading={save.isPending}
          disabled={busy}
          onPress={submit}
        >
          {t('action.save')}
        </Button>
      </View>
    </Section>
  );
}

function EmailSettingsEditor({
  scope,
  settings,
}: {
  scope: DashboardScope;
  settings: MerchantEmailSettings;
}) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const [form, setForm] = useState<EmailSettingsForm>(() => emailSettingsFormOf(settings));
  const [invalid, setInvalid] = useState(false);
  const save = useMutation({
    mutationFn: (body: UpdateMerchantEmailSettingsParams) =>
      dashboardApi.emailSettings.update(scope, body),
    onSuccess: (saved) => {
      queryClient.setQueryData(settingsKey(scope, 'email_settings'), saved);
      setForm(emailSettingsFormOf(saved));
      toast.success(t('emails.saved'));
    },
    onError: fail,
  });
  const set =
    <K extends keyof EmailSettingsForm>(key: K) =>
    (value: EmailSettingsForm[K]) =>
      setForm((prior) => ({ ...prior, [key]: value }));
  const submit = () => {
    const body = buildEmailSettingsPatch(settings, form);
    setInvalid(body === null);
    if (body === null) return;
    if (Object.keys(body).length === 0) {
      toast.success(t('branding.nothingChanged'));
      return;
    }
    save.mutate(body);
  };
  const busy = save.isPending || !can('configure');
  return (
    <Section title={t('emails.title')} description={t('emails.intro')}>
      <Toggle
        label={t('emails.receipts')}
        hint={t('emails.receiptsHelp')}
        value={form.paymentReceipts}
        onChange={set('paymentReceipts')}
        disabled={busy}
      />
      <Toggle
        label={t('emails.refunds')}
        hint={t('emails.refundsHelp')}
        value={form.refundNotices}
        onChange={set('refundNotices')}
        disabled={busy}
      />
      <Toggle
        label={t('emails.confirmations')}
        hint={t('emails.confirmationsHelp')}
        value={form.checkoutConfirmations}
        onChange={set('checkoutConfirmations')}
        disabled={busy}
      />
      <FormField
        label={t('emails.supportEmail')}
        value={form.supportEmail}
        onChange={set('supportEmail')}
        keyboardType="email-address"
        invalid={invalid}
        hint={invalid ? t('emails.supportEmailInvalid') : t('emails.supportEmailHelp')}
        disabled={busy}
      />
      <View className="flex-row justify-end">
        <Button
          appearance="solid"
          tone="accent"
          loading={save.isPending}
          disabled={busy}
          onPress={submit}
        >
          {t('action.save')}
        </Button>
      </View>
    </Section>
  );
}

function Settings({ scope }: { scope: DashboardScope }) {
  const merchant = useQuery({
    queryKey: merchantQueryKey(scope),
    queryFn: () => dashboardApi.merchant.retrieve(scope),
  });
  const branding = useQuery({
    queryKey: settingsKey(scope, 'branding'),
    queryFn: () => dashboardApi.branding.retrieve(scope),
  });
  const emails = useQuery({
    queryKey: settingsKey(scope, 'email_settings'),
    queryFn: () => dashboardApi.emailSettings.retrieve(scope),
  });
  if (merchant.isPending || branding.isPending || emails.isPending) {
    return <PageSkeleton variant="form" accessibilityLabel={t('branding.title')} />;
  }
  const error = merchant.error ?? branding.error ?? emails.error;
  if (error || merchant.data === null) {
    if (merchant.data === null || isMerchantMissing(error)) {
      return <MerchantMissing environment={scope.environment} />;
    }
    return (
      <ErrorNotice
        error={error}
        onRetry={() => {
          void merchant.refetch();
          void branding.refetch();
          void emails.refetch();
        }}
      />
    );
  }
  if (!merchant.data || !branding.data || !emails.data) return null;
  return (
    <View className="gap-6">
      <ActionPermissionNotice action="configure" />
      <BrandingEditor
        key={branding.data.updated_at ?? 'unset'}
        scope={scope}
        branding={branding.data}
        merchantName={merchant.data.display_name ?? t('branding.preview.merchant')}
      />
      <EmailSettingsEditor
        key={emails.data.updated_at ?? 'unset'}
        scope={scope}
        settings={emails.data}
      />
    </View>
  );
}

export default function BrandingScreen() {
  return (
    <OrbitScreen title={t('branding.screenTitle')} description={t('branding.screenIntro')}>
      {({ scope }) => (
        <Settings key={`${scope.applicationId}:${scope.environment}`} scope={scope} />
      )}
    </OrbitScreen>
  );
}
