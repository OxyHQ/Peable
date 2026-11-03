import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreatePaymentLinkParams, PaymentLink } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError, isOrbitApiError } from '@/api/transport';
import { t } from '@/i18n';
import { LinkLinesEditor } from '@/links/LinkLinesEditor';
import { LinkOptionsFields } from '@/links/LinkOptionsFields';
import { LinkShare } from '@/links/LinkShare';
import {
  buildCreateLinkBody,
  EMPTY_LINK_OPTIONS,
  type LinkFormErrors,
  type LinkLineForm,
  type LinkOptionsForm,
  linkCurrency,
  linkFormFields,
  linkSummary,
  serverErrors,
} from '@/links/linkForm';
import { linkKeys } from '@/links/useLinks';
import { OrbitScreen, Section } from '@/ui/OrbitScreen';

function Created({ link, onAnother }: { link: PaymentLink; onAnother: () => void }) {
  const router = useRouter();
  return (
    <Section title={t('links.created')} description={linkSummary(link)}>
      <LinkShare url={link.url} qr />
      <View className="flex-row flex-wrap gap-2">
        <Button
          appearance="outline"
          onPress={() => router.replace({ pathname: '/links/[id]', params: { id: link.id } })}
        >
          {t('links.openDetail')}
        </Button>
        <Button appearance="plain" onPress={onAnother}>
          {t('links.createAnother')}
        </Button>
      </View>
    </Section>
  );
}

function Builder({ scope }: { scope: DashboardScope }) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<LinkLineForm[]>([]);
  const [options, setOptions] = useState<LinkOptionsForm>(EMPTY_LINK_OPTIONS);
  const [errors, setErrors] = useState<LinkFormErrors>({});
  const [created, setCreated] = useState<PaymentLink | null>(null);
  const create = useMutation({
    mutationFn: (body: CreatePaymentLinkParams) => dashboardApi.paymentLinks.create(scope, body),
    onSuccess: (link) => {
      toast.success(t('links.created'));
      setCreated(link);
      void queryClient.invalidateQueries({ queryKey: linkKeys.all(scope) });
    },
    onError: (error) => {
      if (isOrbitApiError(error)) {
        setErrors(
          serverErrors(error.param, linkFormFields(lines.length, options.customFields.length)),
        );
      }
      toast.error(describeError(error, t('error.generic')));
    },
  });
  if (created) {
    return (
      <Created
        link={created}
        onAnother={() => {
          setCreated(null);
          setLines([]);
          setOptions(EMPTY_LINK_OPTIONS);
          setErrors({});
        }}
      />
    );
  }
  const submit = () => {
    const result = buildCreateLinkBody(lines, options);
    setErrors(result.ok ? {} : result.errors);
    if (result.ok) create.mutate(result.body);
    else toast.error(t('links.fixErrors'));
  };
  const currency = linkCurrency(lines);
  return (
    <View className="gap-6">
      <Section
        title={t('links.lines')}
        description={currency ? t('links.linesCurrency', { currency }) : t('links.linesIntro')}
      >
        <LinkLinesEditor
          scope={scope}
          lines={lines}
          onChange={setLines}
          errors={errors}
          disabled={create.isPending}
        />
      </Section>
      <Section title={t('links.options')}>
        <LinkOptionsFields
          form={options}
          onChange={setOptions}
          errors={errors}
          disabled={create.isPending}
        />
      </Section>
      <View className="flex-row flex-wrap items-center justify-end gap-3">
        {Object.keys(errors).length > 0 ? (
          <Text variant="caption-1-regular" className="text-destructive">
            {t('links.fixErrors')}
          </Text>
        ) : null}
        <Button appearance="solid" tone="accent" loading={create.isPending} onPress={submit}>
          {t('links.create')}
        </Button>
      </View>
    </View>
  );
}

export default function NewPaymentLinkScreen() {
  const router = useRouter();
  return (
    <OrbitScreen
      title={t('links.new')}
      description={t('links.newIntro')}
      actions={
        <Button
          appearance="plain"
          size="sm"
          leadingIcon={RiArrowLeftLine}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/links'))}
        >
          {t('nav.links')}
        </Button>
      }
    >
      {({ scope }) => <Builder key={`${scope.applicationId}:${scope.environment}`} scope={scope} />}
    </OrbitScreen>
  );
}
