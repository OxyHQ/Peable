import { useState } from 'react';
import { View, useWindowDimensions, Linking } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
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

import { oxyServices, gateway } from './services';
import { Sidebar } from '@oxy.so/bloom/sidebar';
import {
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
} from '@oxy.so/bloom/table';
import { RiHomeLine } from '@oxy.so/bloom/icons/RiHomeLine';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { RiRepeatLine } from '@oxy.so/bloom/icons/RiRepeatLine';
import { RiBankLine } from '@oxy.so/bloom/icons/RiBankLine';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import { RiHeartLine } from '@oxy.so/bloom/icons/RiHeartLine';
import { RiCodeLine } from '@oxy.so/bloom/icons/RiCodeLine';
import { RiSettingsLine } from '@oxy.so/bloom/icons/RiSettingsLine';
import { RiLayoutGridLine } from '@oxy.so/bloom/icons/RiLayoutGridLine';
import { useOrbitScope } from './scope';
import { sections, sectionInfo } from './sections';
import { t } from './i18n';
import {
  createOrbitReader,
  ORBIT_ENVIRONMENTS,
  OrbitReadError,
  orbitAmount,
  orbitKey,
  type OrbitScope,
  type OrbitEnvironment,
} from './client';

const reader = createOrbitReader(gateway.client);
const navigationIcons: Record<string, typeof RiHomeLine> = {
  overview: RiHomeLine,
  payments: RiBankCardLine,
  customers: RiUserLine,
  subscriptions: RiRepeatLine,
  settlements: RiBankLine,
  disputes: RiShieldLine,
  reports: RiBarChartLine,
  contributions: RiHeartLine,
  developers: RiCodeLine,
  settings: RiSettingsLine,
};
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
  section,
}: {
  viewer: string;
  organization: string;
  scope: OrbitScope;
  section: string;
}) {
  const router = useRouter();
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
  const tax = useQuery({
    queryKey: [...key, 'tax-settings'],
    queryFn: () => reader.taxSettings(scope),
    enabled: !!merchant.data && section === 'tax',
    retry: false,
    gcTime: 0,
  });
  if (section === 'tax' && merchant.data)
    return tax.isPending ? (
      <Text>{t('orbit.loading')}</Text>
    ) : tax.isError ? (
      <Problem error={tax.error} retry={() => void tax.refetch()} />
    ) : (
      <GroupedSection title="Tax settings">
        <GroupedSectionItem title="Legal entity" value={tax.data.legalName || 'Not configured'} />
        <GroupedSectionItem title="Approval status" value={tax.data.status} />
        <GroupedSectionItem title="Default tax behavior" value={tax.data.defaultTaxBehavior} />
        <GroupedSectionItem title="Tax code" value={tax.data.defaultTaxCode} />
        <GroupedSectionItem title="Approved" value={tax.data.approvedAt || 'Not approved'} />
        <GroupedSectionItem
          title="Manage tax registrations"
          description="Continue in the existing authenticated tax tool. Select this organization and application there."
          descriptionLines={0}
          onPress={() => void Linking.openURL('https://peable.to/tax')}
        />
      </GroupedSection>
    );
  if (merchant.isPending) return <Text>{t('orbit.loading')}</Text>;
  if (merchant.isError)
    return (
      <Problem
        error={merchant.error}
        retry={() => void merchant.refetch()}
        missing="notRegistered"
      />
    );
  if (section !== 'payments' && section !== 'webhooks')
    return (
      <View style={{ gap: 24 }}>
        <GroupedSection title="Merchant account">
          <GroupedSectionItem
            title={merchant.data.displayName || merchant.data.id}
            description={merchant.data.id}
            value={scope.environment}
          />
          <GroupedSectionItem title="Application" description={scope.applicationId} />
        </GroupedSection>
        <GroupedSection title={sectionInfo(section).title}>
          <GroupedSectionItem
            title={
              section === 'overview'
                ? 'Your merchant workspace is connected'
                : 'This operation is not available in Orbit yet'
            }
            description={sectionInfo(section).description}
            descriptionLines={0}
          />
        </GroupedSection>
        {section === 'overview' && (
          <GroupedSection title="Explore your business">
            {sections
              .filter((x) => ['payments', 'webhooks', 'settings'].includes(x.id))
              .map((x) => (
                <GroupedSectionItem
                  key={x.id}
                  title={x.title}
                  description={x.description}
                  onPress={() => router.push(`/${x.id}`)}
                />
              ))}
          </GroupedSection>
        )}
        {section === 'settings' && (
          <GroupedSection title="Integration">
            <GroupedSectionItem
              title="Webhook endpoint"
              description={merchant.data.webhookUrl || 'Not configured'}
              descriptionLines={0}
            />
            <GroupedSectionItem
              title="FairCoin network"
              value={merchant.data.network || 'Not configured'}
            />
          </GroupedSection>
        )}
        {['tax', 'contributions'].includes(section) && (
          <Button onPress={() => void Linking.openURL(`https://peable.to/${section}`)}>
            Open existing {section} tool
          </Button>
        )}
      </View>
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
            <Table accessibilityLabel={t(`orbit.${section}`)}>
              <TableHeader>
                <TableColumn>{section === 'payments' ? 'Amount' : 'Event'}</TableColumn>
                <TableColumn>Status</TableColumn>
                <TableColumn>Reference</TableColumn>
              </TableHeader>
              <TableBody>
                {section === 'payments'
                  ? payments.data?.data.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <Button onPress={() => setSelected(row.id)}>
                            {orbitAmount(row.amount, row.currency)} · {row.id}
                          </Button>
                        </TableCell>
                        <TableCell>{row.status}</TableCell>
                        <TableCell>{row.rail}</TableCell>
                      </TableRow>
                    ))
                  : deliveries.data?.data.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.eventType}</TableCell>
                        <TableCell>
                          {row.lastStatus} · {row.attempts} attempts
                        </TableCell>
                        <TableCell>{row.intentId || row.eventId}</TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
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
    </View>
  );
}
function AuthenticatedOrbit({ viewer, section }: { viewer: string; section: string }) {
  const {
    organization,
    setOrganization,
    application,
    setApplication,
    environment,
    setEnvironment,
  } = useOrbitScope();
  const organizations = useQuery({
    queryKey: ['orbit', viewer, 'organizations'],
    queryFn: () => oxyServices.accounts.list(),
    retry: false,
    gcTime: 0,
  });
  const applications = useQuery({
    queryKey: ['orbit', viewer, organization, 'applications'],
    queryFn: () => oxyServices.apps.list(organization),
    enabled:
      !!organization &&
      !!organizations.data?.some(
        (row) =>
          row.accountId === organization && row.kind === 'organization' && row.callerMembership,
      ),
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
      {allowed?.some((row) => row.accountId === organization) &&
      application &&
      apps?.some((app) => app._id === application) ? (
        <Workspace
          key={`${viewer}:${organization}:${application}:${environment}:${section}`}
          viewer={viewer}
          organization={organization}
          scope={scope}
          section={section}
        />
      ) : (
        <Text>{t('orbit.selectScope')}</Text>
      )}
    </View>
  );
}
export default function OrbitApp() {
  const router = useRouter();
  const params = useLocalSearchParams<{ section?: string }>();
  const section = sections.some((x) => x.id === params.section)
    ? String(params.section)
    : 'overview';
  const { width } = useWindowDimensions();
  const { user, canUsePrivateApi, signIn } = useAuth();
  const info = sectionInfo(section);
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      {width >= 900 && (
        <Sidebar
          header={
            <View style={{ padding: 12, gap: 4 }}>
              <Text variant="title-2-semibold">Orbit</Text>
              <Text>by Peable</Text>
            </View>
          }
          items={sections.map((x) => ({
            key: x.id,
            label: x.title,
            icon: navigationIcons[x.id] ?? RiLayoutGridLine,
            href: `/${x.id}`,
          }))}
          selected={section}
          onNavigate={(item) => router.push(item.href || '/overview')}
          showSearch={false}
          showThemeToggle={false}
          style={{ width: 252 }}
        />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Screen header={<PageHeader title={info.title} subtitle="Orbit by Peable" />}>
          <ScreenScrollView
            contentContainerStyle={{
              padding: width < 600 ? 20 : 32,
              gap: 24,
              width: '100%',
              maxWidth: 1320,
              alignSelf: 'center',
            }}
          >
            {width < 900 && (
              <Choice
                label="Workspace navigation"
                value={section}
                options={sections.map((x) => ({ value: x.id, label: x.title }))}
                onChange={(value) => router.push(`/${value}`)}
              />
            )}
            <Text variant="title-1-bold">{info.title}</Text>
            <Text>{info.description}</Text>
            {user?.id && canUsePrivateApi ? (
              <AuthenticatedOrbit key={user.id} viewer={user.id} section={section} />
            ) : (
              <View style={{ gap: 20 }}>
                <GroupedSection title="Your business, in one place">
                  <GroupedSectionItem
                    title="Sign in to your merchant workspace"
                    description="Use your Oxy account to select an organization, application and environment. Your permissions determine which records you can access."
                    descriptionLines={0}
                  />
                </GroupedSection>
                <Button onPress={() => void signIn()}>Sign in with Oxy</Button>
                <GroupedSection title="Workspace access">
                  <GroupedSectionItem
                    title="Organization membership"
                    description="Access follows your existing Oxy organization and application permissions."
                    descriptionLines={0}
                  />
                  <GroupedSectionItem
                    title="Separate environments"
                    description="Development, staging and production are isolated. No financial totals appear before a merchant is selected."
                    descriptionLines={0}
                  />
                </GroupedSection>
              </View>
            )}
          </ScreenScrollView>
        </Screen>
      </View>
    </View>
  );
}
