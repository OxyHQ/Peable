import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { PaymentLink } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Text } from '@oxy.so/bloom/typography';
import type { DashboardScope } from '@/api/dashboard';
import { t } from '@/i18n';
import { linkSummary } from '@/links/linkForm';
import { type LinkFilter, useLinkPages } from '@/links/useLinks';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, ListFooter, OrbitScreen } from '@/ui/OrbitScreen';
import { PermissionNotice, ListEmpty, PageSkeleton } from '@/ui/states';
import { RowLink, Timestamp } from '@/ui/data';

const filterOptions = () => [
  { value: 'active', label: t('links.filter.active') },
  { value: 'inactive', label: t('links.filter.inactive') },
  { value: 'all', label: t('links.filter.all') },
];

function filterValue(filter: LinkFilter): string {
  return filter === null ? 'all' : filter ? 'active' : 'inactive';
}

const COLUMNS = {
  name: { flex: 4, minWidth: 220 },
  status: { flex: 1, minWidth: 100 },
  currency: { width: 80 },
  sessions: { flex: 2, minWidth: 120 },
  created: { flex: 2, minWidth: 140 },
} as const;

/** Payment links, Stripe's table: what it sells, status, currency, completed sessions, created; a row opens it. */
function LinksTable({ links, empty }: { links: PaymentLink[]; empty: ReactNode }) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('links.title')} minWidth={720} size="sm">
      <TableHeader>
        <TableColumn {...COLUMNS.name}>{t('list.column.product')}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('list.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.currency}>{t('links.column.currency')}</TableColumn>
        <TableColumn {...COLUMNS.sessions}>{t('links.column.sessions')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('list.column.created')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {links.map((link) => (
          <RowLink
            key={link.id}
            accessibilityLabel={`${t('link.title')} ${linkSummary(link) || link.id}`}
            onPress={() => router.push({ pathname: '/links/[id]', params: { id: link.id } })}
          >
            <TableRow>
              <TableCell {...COLUMNS.name}>
                <View>
                  <Text variant="body-2-medium" numberOfLines={1}>
                    {linkSummary(link) || link.id}
                  </Text>
                  <Text
                    variant="caption-1-regular"
                    numberOfLines={1}
                    className="text-muted-foreground"
                  >
                    {link.url}
                  </Text>
                </View>
              </TableCell>
              <TableCell {...COLUMNS.status}>
                <Badge
                  appearance="subtle"
                  tone={link.active ? 'success' : 'neutral'}
                  size="label-small"
                  content={link.active ? t('links.active') : t('links.inactive')}
                />
              </TableCell>
              <TableCell {...COLUMNS.currency}>{link.currency.toUpperCase()}</TableCell>
              <TableCell {...COLUMNS.sessions}>
                {link.restrictions
                  ? t('links.sessionsCount', {
                      count: link.restrictions.completed_sessions.count,
                      limit: link.restrictions.completed_sessions.limit,
                    })
                  : '—'}
              </TableCell>
              <TableCell {...COLUMNS.created}>
                <Timestamp seconds={link.created} muted />
              </TableCell>
            </TableRow>
          </RowLink>
        ))}
      </TableBody>
    </Table>
  );
}

function LinkList({ scope, filter }: { scope: DashboardScope; filter: LinkFilter }) {
  const router = useRouter();
  const pages = useLinkPages(scope, filter);
  const { can } = useDashboardPermissions();
  if (pages.isPending) {
    return <PageSkeleton variant="table" accessibilityLabel={t('links.title')} />;
  }
  if (pages.isError)
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  const links = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <PermissionNotice action="configure" />
      <LinksTable
        links={links}
        empty={
          filter === true ? (
            <ListEmpty
              title={t('links.empty.firstTitle')}
              description={t('links.empty.firstBody')}
              {...(can('configure')
                ? { action: { label: t('links.new'), onPress: () => router.push('/links/new') } }
                : {})}
              docs="links"
            />
          ) : (
            <EmptyState
              variant="compact"
              title={t('links.empty.title')}
              description={t('links.empty.body')}
            />
          )
        }
      />
      <ListFooter pages={pages} />
    </View>
  );
}

export default function PaymentLinksScreen() {
  const router = useRouter();
  const { can } = useDashboardPermissions();
  const [filter, setFilter] = useState<LinkFilter>(true);
  return (
    <OrbitScreen
      title={t('links.title')}
      description={t('links.description')}
      actions={
        <Button
          appearance="solid"
          tone="accent"
          disabled={!can('configure')}
          onPress={() => router.push('/links/new')}
        >
          {t('links.new')}
        </Button>
      }
      filters={
        <View className="w-56">
          <Choice
            size="sm"
            label={t('links.filter')}
            value={filterValue(filter)}
            options={filterOptions()}
            onChange={(next) => setFilter(next === 'all' ? null : next === 'active')}
          />
        </View>
      }
    >
      {({ scope }) => <LinkList scope={scope} filter={filter} />}
    </OrbitScreen>
  );
}
