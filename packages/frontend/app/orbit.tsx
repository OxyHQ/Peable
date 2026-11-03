import { useState } from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectItemText,
} from '@oxy.so/bloom/select';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { oxyServices } from '@/services/oxy-services';
import { gateway } from '@/services/gateway-client';
import { t } from '@/i18n';
import {
  createOrbitReader,
  ORBIT_ENVIRONMENTS,
  OrbitReadError,
  orbitAmount,
  orbitKey,
  type OrbitScope,
  type OrbitEnvironment,
} from '@/orbit/client';

const reader = createOrbitReader(gateway.client);
type Option = { value: string; label: string };
function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: Option[];
}) {
  return (
    <View style={{ gap: 8, flexGrow: 1, minWidth: 200 }}>
      <Text>{label}</Text>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger label={label}>
          <SelectValue placeholder={t('orbit.choose')} />
        </SelectTrigger>
        <SelectContent
          label={label}
          items={options}
          renderItem={(item) => (
            <SelectItem value={item.value} label={item.label}>
              <SelectItemText>{item.label}</SelectItemText>
            </SelectItem>
          )}
        />
      </Select>
    </View>
  );
}
function Problem({
  error,
  retry,
  missing = 'notFound',
}: {
  error: unknown;
  retry(): void;
  missing?: string;
}) {
  const key =
    error instanceof OrbitReadError
      ? error.status === 403
        ? 'forbidden'
        : error.status === 404
          ? missing
          : error.status === 401
            ? 'session'
            : 'error'
      : 'error';
  return (
    <View style={{ gap: 12 }}>
      <Text accessibilityRole="alert">{t(`orbit.${key}`)}</Text>
      <Button onPress={retry}>{t('orbit.retry')}</Button>
    </View>
  );
}
function Workspace({
  viewer,
  organization,
  scope,
}: {
  viewer: string;
  organization: string;
  scope: OrbitScope;
}) {
  const router = useRouter();
  const [section, setSection] = useState('payments');
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const cursor = cursors.at(-1);
  const key = orbitKey(viewer, organization, scope);
  const merchant = useQuery({
    queryKey: [...key, 'merchant'],
    queryFn: () => reader.merchant(scope),
    retry: false,
    gcTime: 0,
  });
  const payments = useQuery({
    queryKey: [...key, 'payments', cursor],
    queryFn: () => reader.payments(scope, cursor),
    enabled: !!merchant.data && section === 'payments',
    retry: false,
    gcTime: 0,
  });
  const deliveries = useQuery({
    queryKey: [...key, 'deliveries', cursor],
    queryFn: () => reader.deliveries(scope, cursor),
    enabled: !!merchant.data && section === 'webhooks',
    retry: false,
    gcTime: 0,
  });
  const detail = useQuery({
    queryKey: [...key, 'payment', selected],
    queryFn: () => reader.payment(scope, selected),
    enabled: !!merchant.data && !!selected,
    retry: false,
    gcTime: 0,
  });
  if (merchant.isPending) return <Text>{t('orbit.loading')}</Text>;
  if (merchant.isError)
    return (
      <Problem
        error={merchant.error}
        retry={() => void merchant.refetch()}
        missing="notRegistered"
      />
    );
  const active = section === 'payments' ? payments : deliveries;
  const rows = section === 'payments' ? payments.data?.data : deliveries.data?.data;
  return (
    <View style={{ gap: 20 }}>
      <GroupedSection title={t('orbit.merchant')}>
        <GroupedSectionItem
          title={merchant.data.displayName || merchant.data.id}
          description={merchant.data.id}
          value={t(`orbit.${scope.environment}`)}
        />
        <GroupedSectionItem
          title={t('orbit.faircoin')}
          value={merchant.data.network || t('orbit.notConfigured')}
        />
        <GroupedSectionItem
          title={t('orbit.endpoint')}
          description={merchant.data.webhookUrl || t('orbit.notConfigured')}
          descriptionLines={0}
        />
      </GroupedSection>
      <SegmentedControl
        label={t('orbit.activity')}
        type="tabs"
        value={section}
        onValueChange={(value) => {
          setSection(value);
          setCursors([]);
          setSelected('');
        }}
      >
        {['payments', 'webhooks'].map((value) => (
          <SegmentedControlItem key={value} value={value}>
            <SegmentedControlItemText>{t(`orbit.${value}`)}</SegmentedControlItemText>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <Button onPress={() => void active.refetch()}>{t('orbit.refresh')}</Button>
      {active.isPending ? (
        <Text>{t('orbit.loading')}</Text>
      ) : active.isError ? (
        <Problem error={active.error} retry={() => void active.refetch()} />
      ) : (
        <>
          {!rows?.length ? (
            <Text>{t(`orbit.empty.${section}`)}</Text>
          ) : (
            <GroupedSection title={t(`orbit.${section}`)}>
              {section === 'payments'
                ? payments.data?.data.map((row) => (
                    <GroupedSectionItem
                      key={row.id}
                      title={orbitAmount(row.amount, row.currency)}
                      description={`${row.id} · ${row.status}`}
                      onPress={() => setSelected(row.id)}
                    />
                  ))
                : deliveries.data?.data.map((row) => (
                    <GroupedSectionItem
                      key={row.id}
                      title={row.eventType}
                      description={`${row.eventId} · ${row.lastStatus} · ${t('orbit.attempts')}: ${row.attempts}`}
                      descriptionLines={0}
                      value={row.intentId || undefined}
                    />
                  ))}
            </GroupedSection>
          )}
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <Button
              disabled={!cursors.length}
              onPress={() => setCursors((value) => value.slice(0, -1))}
            >
              {t('orbit.previous')}
            </Button>
            <Button
              disabled={!active.data?.hasMore || !rows?.length}
              onPress={() => {
                const last = rows?.at(-1);
                if (last) setCursors((value) => [...value, last.id]);
              }}
            >
              {t('orbit.next')}
            </Button>
          </View>
        </>
      )}
      {selected && (
        <View style={{ gap: 12 }}>
          <Button onPress={() => setSelected('')}>{t('orbit.closeDetail')}</Button>
          {detail.isPending ? (
            <Text>{t('orbit.loading')}</Text>
          ) : detail.isError ? (
            <Problem error={detail.error} retry={() => void detail.refetch()} />
          ) : (
            <GroupedSection title={t('orbit.paymentDetail')}>
              <GroupedSectionItem
                title={detail.data.id}
                description={detail.data.status}
                titleNumberOfLines={0}
                value={orbitAmount(detail.data.amount, detail.data.currency)}
              />
              <GroupedSectionItem title={t('orbit.method')} value={detail.data.rail} />
              <GroupedSectionItem title={t('orbit.created')} description={detail.data.createdAt} />
              {detail.data.txid && (
                <GroupedSectionItem
                  title={t('orbit.transaction')}
                  description={detail.data.txid}
                  descriptionLines={0}
                />
              )}
            </GroupedSection>
          )}
        </View>
      )}
      <GroupedSection title={t('orbit.tools')}>
        <GroupedSectionItem
          title={t('tax.title')}
          description={t('orbit.chooseScopeAgain')}
          onPress={() => router.push('/tax')}
        />
        <GroupedSectionItem
          title={t('contributions.title')}
          description={t('orbit.chooseScopeAgain')}
          onPress={() => router.push('/contributions')}
        />
      </GroupedSection>
      <GroupedSection title={t('orbit.roadmap')} footer={t('orbit.roadmapHint')}>
        {['customers', 'subscriptions', 'refunds', 'settlements', 'credentials'].map((item) => (
          <GroupedSectionItem
            key={item}
            title={t(`orbit.${item}`)}
            value={t('orbit.notAvailable')}
          />
        ))}
      </GroupedSection>
    </View>
  );
}
function AuthenticatedOrbit({ viewer }: { viewer: string }) {
  const [organization, setOrganization] = useState('');
  const [application, setApplication] = useState('');
  const [environment, setEnvironment] = useState<OrbitEnvironment>('development');
  const organizations = useQuery({
    queryKey: ['orbit', viewer, 'organizations'],
    queryFn: () => oxyServices.accounts.list(),
    retry: false,
    gcTime: 0,
  });
  const applications = useQuery({
    queryKey: ['orbit', viewer, organization, 'applications'],
    queryFn: () => oxyServices.apps.list(organization),
    enabled: !!organization,
    retry: false,
    gcTime: 0,
  });
  const allowed = organizations.data?.filter(
    (row) => row.kind === 'organization' && row.callerMembership,
  );
  const apps = applications.data?.filter((app) => app.status === 'active');
  const scope = { applicationId: application, environment };
  return (
    <View style={{ gap: 24 }}>
      <Text>{t('orbit.intro')}</Text>
      {organizations.isPending ? (
        <Text>{t('orbit.loading')}</Text>
      ) : organizations.isError ? (
        <Problem error={organizations.error} retry={() => void organizations.refetch()} />
      ) : !allowed?.length ? (
        <Text>{t('orbit.noOrganizations')}</Text>
      ) : (
        <Choice
          label={t('orbit.organization')}
          value={organization}
          onChange={(value) => {
            setOrganization(value);
            setApplication('');
          }}
          options={allowed.map((row) => ({
            value: row.accountId,
            label: row.account.username || row.accountId,
          }))}
        />
      )}
      {organization &&
        (applications.isPending ? (
          <Text>{t('orbit.loading')}</Text>
        ) : applications.isError ? (
          <Problem error={applications.error} retry={() => void applications.refetch()} />
        ) : !apps?.length ? (
          <Text>{t('orbit.noApplications')}</Text>
        ) : (
          <Choice
            label={t('orbit.application')}
            value={application}
            onChange={setApplication}
            options={apps.map((app) => ({ value: app._id, label: app.name }))}
          />
        ))}
      <Choice
        label={t('orbit.environment')}
        value={environment}
        onChange={(value) => {
          if (ORBIT_ENVIRONMENTS.some((item) => item === value))
            setEnvironment(value as OrbitEnvironment);
        }}
        options={ORBIT_ENVIRONMENTS.map((value) => ({ value, label: t(`orbit.${value}`) }))}
      />
      {application && apps?.some((app) => app._id === application) ? (
        <Workspace
          key={`${viewer}:${organization}:${application}:${environment}`}
          viewer={viewer}
          organization={organization}
          scope={scope}
        />
      ) : (
        <Text>{t('orbit.selectScope')}</Text>
      )}
    </View>
  );
}
export default function OrbitScreen() {
  const router = useRouter();
  const { user, canUsePrivateApi, signIn } = useAuth();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen
        header={
          <PageHeader title="Orbit" subtitle="by Peable" onBack={() => router.replace('/')} />
        }
      >
        <ScreenScrollView
          contentContainerStyle={{
            padding: 24,
            gap: 24,
            width: '100%',
            maxWidth: 1000,
            alignSelf: 'center',
          }}
        >
          <Text variant="title-1-bold">Orbit by Peable</Text>
          {user?.id && canUsePrivateApi ? (
            <AuthenticatedOrbit key={user.id} viewer={user.id} />
          ) : (
            <View style={{ gap: 16 }}>
              <Text>{t('orbit.signInIntro')}</Text>
              <Button onPress={() => void signIn()}>{t('pay.signIn')}</Button>
              <GroupedSection title={t('orbit.workspace')}>
                <GroupedSectionItem
                  title={t('orbit.payments')}
                  description={t('orbit.paymentsHint')}
                />
                <GroupedSectionItem
                  title={t('orbit.webhooks')}
                  description={t('orbit.webhooksHint')}
                />
                <GroupedSectionItem title={t('orbit.tools')} description={t('orbit.toolsHint')} />
              </GroupedSection>
            </View>
          )}
        </ScreenScrollView>
      </Screen>
    </>
  );
}
