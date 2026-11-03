import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaymentLink, UpdatePaymentLinkParams } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError, isOrbitApiError } from '@/api/transport';
import { formatAmount } from '@/format/money';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { LinkOptionsFields } from '@/links/LinkOptionsFields';
import { LinkShare } from '@/links/LinkShare';
import {
  buildUpdateLinkBody,
  type LinkFormErrors,
  type LinkOptionsForm,
  linkFormFields,
  linkOptionsOf,
  linkSummary,
  serverErrors,
} from '@/links/linkForm';
import { linkKeys, useLink } from '@/links/useLinks';
import { DetailLayout, ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { isNotFound, NotFound, PageSkeleton } from '@/ui/states';

const fail = (error: unknown) => toast.error(describeError(error, t('error.generic')));

function useRefresh(scope: DashboardScope) {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: linkKeys.all(scope) });
}

function LineItems({ link }: { link: PaymentLink }) {
  return (
    <Section title={t('links.lines')} description={t('links.linesFixed')}>
      {link.line_items.map((item) => (
        <View key={item.id} className="gap-1 py-3 border-b border-border">
          <Text variant="body-2-semibold">{item.description}</Text>
          <View className="flex-row flex-wrap gap-x-4 gap-y-1">
            <Text variant="caption-1-regular" className="text-muted-foreground">
              {t('links.quantityValue', { quantity: item.quantity })}
              {item.adjustable_quantity?.enabled
                ? ` · ${t('links.adjustableRange', {
                    minimum: item.adjustable_quantity.minimum ?? 0,
                    maximum: item.adjustable_quantity.maximum ?? 99,
                  })}`
                : ''}
            </Text>
            {item.unit_amount !== null ? (
              <Text variant="caption-1-regular" className="text-muted-foreground">
                {formatAmount(item.unit_amount, item.currency)}
              </Text>
            ) : null}
            {typeof item.price === 'string' ? (
              <Text
                variant="caption-1-regular"
                selectable
                className="text-muted-foreground font-mono"
              >
                {item.price}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </Section>
  );
}

function EditOptions({ scope, link }: { scope: DashboardScope; link: PaymentLink }) {
  const refresh = useRefresh(scope);
  const [form, setForm] = useState<LinkOptionsForm>(() => linkOptionsOf(link));
  const [errors, setErrors] = useState<LinkFormErrors>({});
  const save = useMutation({
    mutationFn: (body: UpdatePaymentLinkParams) =>
      dashboardApi.paymentLinks.update(scope, link.id, body),
    onSuccess: () => {
      toast.success(t('links.saved'));
      refresh();
    },
    onError: (error) => {
      if (isOrbitApiError(error)) {
        setErrors(serverErrors(error.param, linkFormFields(0, form.customFields.length)));
      }
      fail(error);
    },
  });
  const submit = () => {
    const result = buildUpdateLinkBody(form);
    setErrors(result.ok ? {} : result.errors);
    if (result.ok) save.mutate(result.body);
    else toast.error(t('links.fixErrors'));
  };
  return (
    <Section title={t('links.options')}>
      <LinkOptionsFields form={form} onChange={setForm} errors={errors} disabled={save.isPending} />
      <View className="flex-row justify-end">
        <Button appearance="solid" tone="accent" loading={save.isPending} onPress={submit}>
          {t('action.save')}
        </Button>
      </View>
    </Section>
  );
}

function LinkDetail({ scope, link }: { scope: DashboardScope; link: PaymentLink }) {
  const refresh = useRefresh(scope);
  const toggle = useMutation({
    mutationFn: () => dashboardApi.paymentLinks.update(scope, link.id, { active: !link.active }),
    onSuccess: (updated) => {
      toast.success(updated.active ? t('links.activated') : t('links.deactivated'));
      refresh();
    },
    onError: fail,
  });
  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap items-center gap-3">
        <Text variant="title-1-bold" selectable>
          {linkSummary(link) || link.id}
        </Text>
        <Badge
          appearance="subtle"
          tone={link.active ? 'success' : 'neutral'}
          size="label-small"
          content={link.active ? t('links.active') : t('links.inactive')}
        />
      </View>
      <DetailLayout
        aside={
          <>
            <Section title={t('links.share')}>
              <LinkShare url={link.url} qr />
              <View className="flex-row flex-wrap gap-2">
                <Button
                  appearance="outline"
                  size="sm"
                  loading={toggle.isPending}
                  onPress={() => toggle.mutate()}
                >
                  {link.active ? t('links.deactivate') : t('links.activate')}
                </Button>
              </View>
              <Text variant="caption-1-regular" className="text-muted-foreground">
                {t('links.deactivateHelp')}
              </Text>
            </Section>
            <Section title={t('links.details')}>
              <Field label={t('links.field.id')} value={link.id} mono />
              <Field label={t('links.field.currency')} value={link.currency} />
              <Field label={t('links.field.created')} value={formatInstant(link.created)} />
              {link.restrictions ? (
                <Field
                  label={t('links.field.sessions')}
                  value={t('links.sessionsCount', {
                    count: link.restrictions.completed_sessions.count,
                    limit: link.restrictions.completed_sessions.limit,
                  })}
                />
              ) : null}
            </Section>
          </>
        }
      >
        {link.contribution ? null : <LineItems link={link} />}
        {/* Keyed by `updated_at`, so a save re-seeds the form from the stored link. */}
        {link.contribution ? null : <EditOptions key={link.updated_at} scope={scope} link={link} />}
      </DetailLayout>
    </View>
  );
}

function LinkLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useLink(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('link.title')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('links.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <LinkDetail scope={scope} link={query.data} />;
}

export default function PaymentLinkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('link.title')}>
      {({ scope }) => (id ? <LinkLoader scope={scope} id={id} /> : null)}
    </OrbitScreen>
  );
}
