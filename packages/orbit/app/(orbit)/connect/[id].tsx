import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AccountLink, ConnectedAccount } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { dashboardApi } from '@/api/client';
import type { DashboardScope } from '@/api/dashboard';
import { describeError } from '@/api/transport';
import { sellerLinkBody, sellerReadiness } from '@/connect/forms';
import { Transfers } from '@/connect/Transfers';
import { connectKeys, useSeller } from '@/connect/useConnect';
import { railLabel, readinessLabel, readinessTone } from '@/connect/vocabulary';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import {
  disabledReasonLabel,
  REQUIREMENT_GROUPS,
  requirementLabels,
  requirementsClear,
} from '@/money/requirements';
import { DetailLayout, ErrorNotice, Field, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { PermissionNotice, isNotFound, NotFound, PageSkeleton } from '@/ui/states';
import { orbitOrigin } from '@/ui/origin';
import { CapabilityBadge, EnabledBadge, ToneBadge } from '@/ui/StatusBadge';

type Rail = 'card' | 'faircoin';

/**
 * A minted onboarding link, shown to be COPIED: it is the seller who opens it,
 * not the marketplace. It is never stored — it expires within minutes at the
 * provider (a FairCoin key link within the hour).
 */
function MintedLink({ link }: { link: AccountLink }) {
  return (
    <View className="gap-2 rounded-xl border border-border p-4">
      <Text variant="body-2-regular" selectable className="font-mono">
        {link.url}
      </Text>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        {t('connect.link.expires', { at: formatInstant(link.expires_at) })}
      </Text>
      <View className="flex-row">
        <Button
          appearance="outline"
          size="sm"
          onPress={async () => {
            await Clipboard.setStringAsync(link.url);
            toast.success(t('connect.link.copied'));
          }}
        >
          {t('action.copy')}
        </Button>
      </View>
    </View>
  );
}

function Onboarding({ scope, seller }: { scope: DashboardScope; seller: ConnectedAccount }) {
  const [links, setLinks] = useState<Partial<Record<Rail, AccountLink>>>({});
  const { can } = useDashboardPermissions();
  const mint = useMutation({
    mutationFn: (rail: Rail) =>
      dashboardApi.connectedAccounts.createLink(
        scope,
        seller.id,
        sellerLinkBody(orbitOrigin(), seller.id, rail),
      ),
    onSuccess: (link, rail) => setLinks((prior) => ({ ...prior, [rail]: link })),
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  const rails: Rail[] = [];
  if (seller.rails.includes('card')) rails.push('card');
  if (seller.faircoin?.status === 'pending') rails.push('faircoin');
  return (
    <Section title={t('connect.onboarding')} description={t('connect.onboarding.help')}>
      {rails.length === 0 ? (
        <Text variant="body-2-regular" className="text-muted-foreground">
          {t('connect.onboarding.nothing')}
        </Text>
      ) : (
        rails.map((rail) => {
          const link = links[rail];
          return (
            <View key={rail} className="gap-3">
              <View className="flex-row flex-wrap items-center gap-3">
                <Button
                  appearance="outline"
                  tone="accent"
                  size="sm"
                  loading={mint.isPending && mint.variables === rail}
                  disabled={!can('money')}
                  onPress={() => mint.mutate(rail)}
                >
                  {t(`connect.onboarding.${rail}`)}
                </Button>
                <Text variant="caption-1-regular" className="text-muted-foreground flex-1 min-w-48">
                  {t(`connect.onboarding.${rail}Help`)}
                </Text>
              </View>
              {link ? <MintedLink link={link} /> : null}
            </View>
          );
        })
      )}
    </Section>
  );
}

function Requirements({ seller }: { seller: ConnectedAccount }) {
  const { requirements } = seller;
  const reason = disabledReasonLabel(requirements.disabled_reason);
  return (
    <Section title={t('account.requirements')} description={t('connect.requirementsIntro')}>
      {requirementsClear(requirements) ? (
        <Text variant="body-2-regular" className="text-muted-foreground">
          {t('account.requirements.allClear')}
        </Text>
      ) : (
        <View>
          {reason ? (
            <Field label={t('account.requirements.disabledReason')} value={reason} />
          ) : null}
          {REQUIREMENT_GROUPS.filter((group) => requirements[group].length > 0).map((group) => (
            <Field
              key={group}
              label={t(`account.requirements.${group}`)}
              value={requirementLabels(requirements[group])
                .map((item) => `• ${item}`)
                .join('\n')}
            />
          ))}
        </View>
      )}
    </Section>
  );
}

function SellerDetail({ scope, seller }: { scope: DashboardScope; seller: ConnectedAccount }) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const readiness = sellerReadiness(seller);
  const notSet = t('account.notSet');
  const refresh = useMutation({
    mutationFn: () => dashboardApi.connectedAccounts.refresh(scope, seller.id),
    onSuccess: (fresh) => {
      queryClient.setQueryData(connectKeys.seller(scope, seller.id), fresh);
      void queryClient.invalidateQueries({ queryKey: connectKeys.sellers(scope) });
      toast.success(t('connect.refreshed'));
    },
    onError: (error) => toast.error(describeError(error, t('error.generic'))),
  });
  const card = seller.rails.includes('card');
  return (
    <View className="gap-6">
      <PermissionNotice action="money" />
      <View className="flex-row flex-wrap items-center gap-3">
        <Text variant="title-1-bold" selectable>
          {seller.external_ref}
        </Text>
        <ToneBadge tone={readinessTone(readiness)} label={readinessLabel(readiness)} />
      </View>
      <DetailLayout
        aside={
          <>
            <Section
              title={t('account.status')}
              actions={
                card ? (
                  <Button
                    appearance="outline"
                    size="sm"
                    loading={refresh.isPending}
                    disabled={!can('money')}
                    onPress={() => refresh.mutate()}
                  >
                    {t('connect.refresh')}
                  </Button>
                ) : undefined
              }
            >
              <Field label={t('connect.field.id')} value={seller.id} mono />
              <Field label={t('connect.field.externalRef')} value={seller.external_ref} mono />
              <Field
                label={t('connect.column.rails')}
                value={seller.rails.map(railLabel).join(', ')}
              />
              {card ? (
                <>
                  <Field
                    label={t('connect.field.payable')}
                    value={<EnabledBadge enabled={seller.payable} />}
                  />
                  <Field
                    label={t('account.charges')}
                    value={<EnabledBadge enabled={seller.charges_enabled} />}
                  />
                  <Field
                    label={t('account.payouts')}
                    value={<EnabledBadge enabled={seller.payouts_enabled} />}
                  />
                  <Field
                    label={t('account.capability.card_payments')}
                    value={<CapabilityBadge status={seller.card_payments_capability} />}
                  />
                  <Field
                    label={t('account.capability.transfers')}
                    value={<CapabilityBadge status={seller.transfers_capability} />}
                  />
                  <Field label={t('account.country')} value={seller.country ?? notSet} />
                  <Field
                    label={t('account.defaultCurrency')}
                    value={seller.default_currency?.toUpperCase() ?? notSet}
                  />
                </>
              ) : null}
              <Field
                label={t('account.lastSynced')}
                value={
                  seller.last_synced_at === null
                    ? t('account.never')
                    : formatInstant(seller.last_synced_at)
                }
              />
              <Field label={t('connect.column.created')} value={formatInstant(seller.created)} />
            </Section>
            {seller.faircoin ? (
              <Section title={t('connect.faircoin')} description={t('connect.faircoinIntro')}>
                <Field label={t('settings.network')} value={seller.faircoin.network} />
                <Field
                  label={t('connect.field.faircoinStatus')}
                  value={t(`connect.faircoinStatus.${seller.faircoin.status}`)}
                />
                <Field
                  label={t('connect.field.oxyUser')}
                  value={seller.faircoin.oxy_user_id}
                  mono
                />
                <Field
                  label={t('connect.field.registered')}
                  value={
                    seller.faircoin.registered_at === null
                      ? t('account.never')
                      : formatInstant(seller.faircoin.registered_at)
                  }
                />
              </Section>
            ) : null}
          </>
        }
      >
        <Onboarding scope={scope} seller={seller} />
        {card ? <Requirements seller={seller} /> : null}
        <Transfers scope={scope} seller={seller.id} />
      </DetailLayout>
    </View>
  );
}

function SellerLoader({ scope, id }: { scope: DashboardScope; id: string }) {
  const query = useSeller(scope, id);
  if (query.isPending)
    return <PageSkeleton variant="detail" accessibilityLabel={t('connect.seller')} />;
  if (query.isError) {
    // A 404 for this object (a first run is the page gate's): it does not exist in this mode.
    if (isNotFound(query.error)) return <NotFound title={t('connect.notFound')} />;
    return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <SellerDetail scope={scope} seller={query.data} />;
}

export default function SellerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <OrbitScreen title={t('connect.seller')}>
      {({ scope }) =>
        id ? (
          <SellerLoader
            key={`${scope.applicationId}:${scope.environment}:${id}`}
            scope={scope}
            id={id}
          />
        ) : null
      }
    </OrbitScreen>
  );
}
