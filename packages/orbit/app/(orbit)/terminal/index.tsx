import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TerminalLocation } from '@peable.to/shared-types';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { dashboardApi } from '@/api/client';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { t } from '@/i18n';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { LocationEditor } from '@/terminal/LocationEditor';
import { RegisterReader } from '@/terminal/RegisterReader';
import { LocationsTable, ReadersTable, terminalErrorMessage } from '@/terminal/TerminalParts';
import {
  terminalKeys,
  useLocationOptions,
  useLocationPages,
  useReaderPages,
} from '@/terminal/useTerminal';
import { ErrorNotice, ListFooter, OrbitScreen, Section, SetupPayments } from '@/ui/OrbitScreen';
import { ListEmpty, PageSkeleton } from '@/ui/states';

type Editing = { kind: 'new' } | { kind: 'edit'; location: TerminalLocation } | null;

function Readers({
  scope,
  locations,
  onRegister,
}: {
  scope: DashboardScope;
  locations: readonly TerminalLocation[];
  onRegister: () => void;
}) {
  const { can } = useDashboardPermissions();
  const pages = useReaderPages(scope);
  const names = useMemo(
    () => new Map(locations.map((location) => [location.id, location.display_name])),
    [locations],
  );
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('terminal.readers')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <SetupPayments environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <ReadersTable
        readers={rows}
        locationNames={names}
        empty={
          <ListEmpty
            title={t('terminal.readers.emptyTitle')}
            description={t('terminal.readers.emptyBody')}
            {...(can('money')
              ? { action: { label: t('terminal.registerReader'), onPress: onRegister } }
              : {})}
          />
        }
      />
      <ListFooter pages={pages} />
    </View>
  );
}

function Locations({
  scope,
  onAdd,
  onEdit,
}: {
  scope: DashboardScope;
  onAdd: () => void;
  onEdit: (location: TerminalLocation) => void;
}) {
  const queryClient = useQueryClient();
  const { can } = useDashboardPermissions();
  const pages = useLocationPages(scope);
  const [confirming, setConfirming] = useState<TerminalLocation | null>(null);
  const remove = useMutation({
    mutationFn: (location: TerminalLocation) =>
      dashboardApi.terminal.locations.delete(scope, location.id),
    onSuccess: () => {
      toast.success(t('terminal.location.deleted'));
      void queryClient.invalidateQueries({ queryKey: terminalKeys.all(scope) });
    },
    onError: (error) => {
      toast.error(t('terminal.location.deleteFailed', { reason: terminalErrorMessage(error) }));
      void queryClient.invalidateQueries({ queryKey: terminalKeys.all(scope) });
    },
  });
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('terminal.locations')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <SetupPayments environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <LocationsTable
        locations={rows}
        canWrite={can('money')}
        busyId={remove.isPending ? (remove.variables?.id ?? null) : null}
        onEdit={onEdit}
        onDelete={setConfirming}
        empty={
          <ListEmpty
            title={t('terminal.locations.emptyTitle')}
            description={t('terminal.locations.emptyBody')}
            {...(can('money')
              ? { action: { label: t('terminal.addLocation'), onPress: onAdd } }
              : {})}
          />
        }
      />
      <ListFooter pages={pages} />
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t('terminal.location.confirmDelete.title', {
          name: confirming?.display_name ?? '',
        })}
        description={t('terminal.location.confirmDelete.body')}
        confirmLabel={t('terminal.location.confirmDelete.action')}
        cancelLabel={t('reader.confirm.keep')}
        destructive
        onConfirm={() => {
          const location = confirming;
          setConfirming(null);
          if (location) remove.mutate(location);
        }}
      />
    </View>
  );
}

function TerminalPage({
  scope,
  registering,
  setRegistering,
  editing,
  setEditing,
}: {
  scope: DashboardScope;
  registering: boolean;
  setRegistering: (open: boolean) => void;
  editing: Editing;
  setEditing: (editing: Editing) => void;
}) {
  const router = useRouter();
  const options = useLocationOptions(scope);
  const locations = options.data ?? [];
  return (
    <View className="gap-6">
      {registering ? (
        options.isError ? (
          <ErrorNotice error={options.error} onRetry={() => void options.refetch()} />
        ) : options.isPending ? (
          <PageSkeleton variant="form" accessibilityLabel={t('terminal.reader.formTitle')} />
        ) : (
          <RegisterReader
            scope={scope}
            locations={locations}
            onClose={() => setRegistering(false)}
            onRegistered={(reader) => {
              setRegistering(false);
              router.push({ pathname: '/terminal/readers/[id]', params: { id: reader.id } });
            }}
          />
        )
      ) : null}
      {editing ? (
        <LocationEditor
          key={editing.kind === 'edit' ? editing.location.id : 'new'}
          scope={scope}
          {...(editing.kind === 'edit' ? { location: editing.location } : {})}
          onClose={() => setEditing(null)}
          onDone={() => setEditing(null)}
        />
      ) : null}
      <Section title={t('terminal.readers')} description={t('terminal.readers.description')}>
        <Readers scope={scope} locations={locations} onRegister={() => setRegistering(true)} />
      </Section>
      <Section title={t('terminal.locations')} description={t('terminal.locations.description')}>
        <Locations
          scope={scope}
          onAdd={() => setEditing({ kind: 'new' })}
          onEdit={(location) => setEditing({ kind: 'edit', location })}
        />
      </Section>
    </View>
  );
}

export default function TerminalScreen() {
  const { can } = useDashboardPermissions();
  const [registering, setRegistering] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  return (
    <OrbitScreen
      title={t('terminal.title')}
      description={t('terminal.description')}
      actions={
        <>
          <Button
            appearance="outline"
            tone="accent"
            disabled={!can('money')}
            onPress={() => setEditing({ kind: 'new' })}
          >
            {t('terminal.addLocation')}
          </Button>
          <Button
            appearance="solid"
            tone="accent"
            disabled={!can('money')}
            onPress={() => setRegistering(true)}
          >
            {t('terminal.registerReader')}
          </Button>
        </>
      }
    >
      {({ scope }) => (
        <TerminalPage
          scope={scope}
          registering={registering}
          setRegistering={setRegistering}
          editing={editing}
          setEditing={setEditing}
        />
      )}
    </OrbitScreen>
  );
}
