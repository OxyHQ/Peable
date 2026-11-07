import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { VerificationSession, VerificationSessionStatus } from '@peable.to/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { t } from '@/i18n';
import { CreateVerification } from '@/identity/CreateVerification';
import { HostedLink, VerificationTable, verificationStatusLabel } from '@/identity/IdentityParts';
import { hostedLinkOf, ORBIT_VERIFICATION_STATUSES } from '@/identity/identityForm';
import { useVerificationSessionPages } from '@/identity/useIdentity';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, ListFooter, OrbitScreen, SetupPayments } from '@/ui/OrbitScreen';
import { ListEmpty, PageSkeleton } from '@/ui/states';

const ALL = 'all';
// Built at render: the language can change while Orbit is open.
const options = () => [
  { value: ALL, label: t('identity.filter.all') },
  ...ORBIT_VERIFICATION_STATUSES.map((status) => ({
    value: status,
    label: verificationStatusLabel(status),
  })),
];

function SessionList({
  scope,
  status,
  onCreate,
}: {
  scope: DashboardScope;
  status: VerificationSessionStatus | null;
  onCreate: () => void;
}) {
  const { can } = useDashboardPermissions();
  const pages = useVerificationSessionPages(scope, status);
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('identity.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <SetupPayments environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <VerificationTable
        sessions={rows}
        empty={
          status ? (
            <EmptyState
              variant="compact"
              title={t('identity.empty.title')}
              description={t('identity.empty.body')}
            />
          ) : (
            <ListEmpty
              title={t('identity.empty.firstTitle')}
              description={t('identity.empty.firstBody')}
              {...(can('money') ? { action: { label: t('identity.new'), onPress: onCreate } } : {})}
            />
          )
        }
      />
      <ListFooter pages={pages} />
    </View>
  );
}

function Created({ session, onDone }: { session: VerificationSession; onDone: () => void }) {
  const router = useRouter();
  const url = hostedLinkOf(session);
  if (!url) return null;
  return (
    <HostedLink
      url={url}
      footer={
        <Button
          appearance="plain"
          size="sm"
          onPress={() => {
            onDone();
            router.push({ pathname: '/identity/[id]', params: { id: session.id } });
          }}
        >
          {t('identity.link.open')}
        </Button>
      }
    />
  );
}

export default function IdentityScreen() {
  const { can } = useDashboardPermissions();
  const [status, setStatus] = useState<VerificationSessionStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<VerificationSession | null>(null);
  const open = () => {
    setCreated(null);
    setCreating(true);
  };
  return (
    <OrbitScreen
      title={t('identity.title')}
      description={t('identity.description')}
      actions={
        <Button appearance="solid" tone="accent" disabled={!can('money')} onPress={open}>
          {t('identity.new')}
        </Button>
      }
      filters={
        <View className="w-56">
          <Choice
            size="sm"
            label={t('identity.filter')}
            value={status ?? ALL}
            options={options()}
            onChange={(next) =>
              setStatus(next === ALL ? null : (next as VerificationSessionStatus))
            }
          />
        </View>
      }
    >
      {({ scope }) => (
        <View className="gap-4">
          {created ? <Created session={created} onDone={() => setCreated(null)} /> : null}
          {creating ? (
            <CreateVerification
              scope={scope}
              onClose={() => setCreating(false)}
              onCreated={(session) => {
                setCreating(false);
                setCreated(session);
              }}
            />
          ) : null}
          <SessionList scope={scope} status={status} onCreate={open} />
        </View>
      )}
    </OrbitScreen>
  );
}
