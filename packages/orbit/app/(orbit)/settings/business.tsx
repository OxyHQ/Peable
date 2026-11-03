import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Account, UpdateAccountParams } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import {
  type BusinessField,
  type BusinessForm,
  type BusinessFormError,
  buildBusinessBody,
  businessFormOf,
} from '@/account/businessForm';
import { dashboardApi } from '@/api/client';
import { type DashboardScope, isMerchantMissing } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { t } from '@/i18n';
import { moneyKeys, useAccount } from '@/money/useMoney';
import { FormField } from '@/ui/FormField';
import {
  AccountMissing,
  ErrorNotice,
  MerchantMissing,
  OrbitScreen,
  Section,
} from '@/ui/OrbitScreen';
import { PageSkeleton } from '@/ui/states';

const PROFILE_FIELDS: readonly {
  field: BusinessField;
  keyboard?: 'url' | 'email-address' | 'number-pad';
  multiline?: boolean;
}[] = [
  { field: 'name' },
  { field: 'url', keyboard: 'url' },
  { field: 'supportEmail', keyboard: 'email-address' },
  { field: 'supportUrl', keyboard: 'url' },
  { field: 'productDescription', multiline: true },
  { field: 'mcc', keyboard: 'number-pad' },
];
const DESCRIPTOR_FIELDS: readonly BusinessField[] = ['statementDescriptor', 'payoutDescriptor'];

function BusinessDetails({ scope, account }: { scope: DashboardScope; account: Account }) {
  const queryClient = useQueryClient();
  const current = businessFormOf(account);
  const [form, setForm] = useState<BusinessForm>(current);
  const [invalid, setInvalid] = useState<BusinessFormError | null>(null);

  // A saved account resets the form to what the provider now reports.
  useEffect(() => {
    setForm(businessFormOf(account));
    setInvalid(null);
  }, [account]);

  const save = useMutation({
    mutationFn: (body: UpdateAccountParams) => dashboardApi.account.update(scope, body),
    onSuccess: (saved) => {
      queryClient.setQueryData(moneyKeys.account(scope), saved);
      toast.success(t('business.saved'));
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  const submit = () => {
    const result = buildBusinessBody(form, current);
    setInvalid(result.ok ? null : result.error);
    if (!result.ok) return;
    if (result.body === null) toast.success(t('business.nothingChanged'));
    else save.mutate(result.body);
  };
  const busy = save.isPending;
  const field = (
    name: BusinessField,
    options: { keyboard?: 'url' | 'email-address' | 'number-pad'; multiline?: boolean } = {},
  ) => {
    const wrong = invalid?.field === name;
    return (
      <FormField
        key={name}
        label={t(`business.field.${name}`)}
        value={form[name]}
        onChange={(value) => setForm((prior) => ({ ...prior, [name]: value }))}
        invalid={wrong}
        {...(wrong
          ? {
              hint: t(
                invalid.reason === 'cannotClear' ? 'business.cannotClear' : 'business.invalid',
              ),
            }
          : {})}
        {...(options.keyboard ? { keyboardType: options.keyboard } : {})}
        multiline={options.multiline}
        autoCapitalize={name === 'name' || name === 'productDescription' ? 'sentences' : 'none'}
        disabled={busy}
      />
    );
  };

  return (
    <View className="gap-6">
      <Section title={t('business.profile')}>
        {PROFILE_FIELDS.map(({ field: name, keyboard, multiline }) =>
          field(name, { ...(keyboard ? { keyboard } : {}), ...(multiline ? { multiline } : {}) }),
        )}
      </Section>
      <Section title={t('business.descriptors')} description={t('business.descriptorsIntro')}>
        {DESCRIPTOR_FIELDS.map((name) => field(name))}
      </Section>
      <View className="flex-row justify-end">
        <Button appearance="solid" tone="accent" loading={busy} onPress={submit}>
          {t('business.save')}
        </Button>
      </View>
    </View>
  );
}

function BusinessLoader({ scope }: { scope: DashboardScope }) {
  const query = useAccount(scope);
  if (query.isPending)
    return <PageSkeleton variant="form" accessibilityLabel={t('business.title')} />;
  if (query.isError) {
    if (isMerchantMissing(query.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.data === null) return <AccountMissing environment={scope.environment} />;
  return <BusinessDetails scope={scope} account={query.data} />;
}

export default function BusinessScreen() {
  return (
    <OrbitScreen title={t('business.title')} description={t('business.description')}>
      {({ scope }) => (
        <BusinessLoader key={`${scope.applicationId}:${scope.environment}`} scope={scope} />
      )}
    </OrbitScreen>
  );
}
