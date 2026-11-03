import { Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { Loading } from '@oxy.so/bloom/loading';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { Text } from '@oxy.so/bloom/typography';
import { OXY_CONSOLE_URL } from '@/config';
import { labelFor, t } from '@/i18n';
import { organizationLabel } from '@/scope/scope';
import type { OrbitScopeValue } from '@/scope/ScopeProvider';
import { peableAccessOf, sortMembers } from '@/team/permissions';
import { type TeamRow, useTeam } from '@/team/useTeam';
import { ErrorNotice, OrbitScreen, Section } from '@/ui/OrbitScreen';
import { ToneBadge } from '@/ui/StatusBadge';

/** Members are changed in Oxy Console's account settings, never here. */
const CONSOLE_MEMBERS_URL = `${OXY_CONSOLE_URL.replace(/\/+$/, '')}/settings/account`;

const COLUMNS = {
  member: { flex: 3, minWidth: 220 },
  role: { flex: 2, minWidth: 140 },
  orbit: { flex: 1, minWidth: 90 },
  taxRead: { flex: 1, minWidth: 120 },
  taxManage: { flex: 1, minWidth: 130 },
} as const;

function Allowed({ allowed }: { allowed: boolean }) {
  return (
    <ToneBadge
      tone={allowed ? 'success' : 'neutral'}
      label={allowed ? t('team.yes') : t('team.no')}
    />
  );
}

function ConsoleLink() {
  return (
    <View className="flex-row">
      <Button
        appearance="outline"
        size="sm"
        onPress={() => void Linking.openURL(CONSOLE_MEMBERS_URL)}
      >
        {t('team.console')}
      </Button>
    </View>
  );
}

function MembersTable({
  rows,
  ownerAccountId,
  context,
  me,
}: {
  rows: readonly TeamRow[];
  ownerAccountId: string;
  context: OrbitScopeValue;
  me: string | null;
}) {
  const accountName = (accountId: string) => {
    const node = context.organizations.find((candidate) => candidate.accountId === accountId);
    return node
      ? t('team.inherited', { account: organizationLabel(node) })
      : t('team.inheritedParent');
  };
  return (
    <Table accessibilityLabel={t('team.members')} minWidth={760}>
      <TableHeader>
        <TableColumn {...COLUMNS.member}>{t('team.column.member')}</TableColumn>
        <TableColumn {...COLUMNS.role}>{t('team.column.role')}</TableColumn>
        <TableColumn {...COLUMNS.orbit}>{t('team.column.orbit')}</TableColumn>
        <TableColumn {...COLUMNS.taxRead}>{t('team.column.taxRead')}</TableColumn>
        <TableColumn {...COLUMNS.taxManage}>{t('team.column.taxManage')}</TableColumn>
      </TableHeader>
      <TableBody>
        {sortMembers(rows).map(({ member, name, handle }) => {
          const access = peableAccessOf(member);
          return (
            <TableRow key={member._id}>
              <TableCell {...COLUMNS.member}>
                <View className="gap-0.5">
                  <Text variant="body-2-semibold">
                    {member.memberUserId === me ? `${name} (${t('team.you')})` : name}
                  </Text>
                  {handle ? (
                    <Text variant="caption-1-regular" className="text-muted-foreground">
                      @{handle}
                    </Text>
                  ) : null}
                  {member.source === 'inherited' || member.accountId !== ownerAccountId ? (
                    <Text variant="caption-1-regular" className="text-muted-foreground">
                      {accountName(member.accountId)}
                    </Text>
                  ) : null}
                </View>
              </TableCell>
              <TableCell {...COLUMNS.role}>
                <View className="flex-row flex-wrap gap-1">
                  <Text variant="body-2-regular">{labelFor('team.role', member.role)}</Text>
                  {member.status === 'invited' ? (
                    <ToneBadge tone="info" label={t('team.invited')} />
                  ) : null}
                </View>
              </TableCell>
              <TableCell {...COLUMNS.orbit}>
                <Allowed allowed={access.orbit} />
              </TableCell>
              <TableCell {...COLUMNS.taxRead}>
                <Allowed allowed={access.taxRead} />
              </TableCell>
              <TableCell {...COLUMNS.taxManage}>
                <Allowed allowed={access.taxManage} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function Team({ context }: { context: OrbitScopeValue }) {
  const { user } = useAuth();
  const application = context.applications.find((app) => app._id === context.applicationId);
  const ownerAccountId = application?.ownerAccountId ?? null;
  const team = useTeam(ownerAccountId);

  let body: React.ReactNode;
  if (!ownerAccountId) {
    body = (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('team.noApplication')}
      </Text>
    );
  } else if (team.isPending) {
    body = <Loading accessibilityLabel={t('team.members')} />;
  } else if (team.isError) {
    const status = (team.error as { status?: unknown } | null)?.status;
    body =
      status === 403 ? (
        <EmptyState
          variant="compact"
          title={t('team.forbidden.title')}
          description={t('team.forbidden.body')}
        />
      ) : (
        <ErrorNotice error={team.error} onRetry={() => void team.refetch()} />
      );
  } else if (!team.data.length) {
    body = (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('team.empty')}
      </Text>
    );
  } else {
    body = (
      <MembersTable
        rows={team.data}
        ownerAccountId={ownerAccountId}
        context={context}
        me={user?.id ?? null}
      />
    );
  }

  return (
    <View className="gap-6">
      <Section title={t('team.members')} description={t('team.readOnly')} actions={<ConsoleLink />}>
        {body}
      </Section>
      <Section title={t('team.permissions')}>
        {(['orbit', 'taxRead', 'taxManage'] as const).map((permission) => (
          <Text key={permission} variant="body-2-regular" className="text-muted-foreground">
            {`• ${t(`team.permission.${permission}`)}`}
          </Text>
        ))}
      </Section>
    </View>
  );
}

export default function TeamScreen() {
  const router = useRouter();
  return (
    <OrbitScreen
      title={t('team.title')}
      description={t('team.description')}
      actions={
        <Button
          appearance="plain"
          size="sm"
          leadingIcon={RiArrowLeftLine}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
        >
          {t('settings.back')}
        </Button>
      }
    >
      {(context) => <Team context={context} />}
    </OrbitScreen>
  );
}
