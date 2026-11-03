import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Dispute } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { Text } from '@oxy.so/bloom/typography';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { disputeReasonLabel } from '@/disputes/evidence';
import { useDisputePages } from '@/disputes/useDisputes';
import { formatAmount } from '@/format/money';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { ErrorNotice, ListFooter, MerchantMissing, OrbitScreen } from '@/ui/OrbitScreen';
import { DisputeStatusBadge } from '@/ui/StatusBadge';
import { PageSkeleton } from '@/ui/states';
import { RowLink } from '@/ui/data';

const COLUMNS = {
  amount: { flex: 2, minWidth: 130, align: 'end' },
  status: { flex: 2, minWidth: 140 },
  reason: { flex: 2, minWidth: 160 },
  due: { flex: 2, minWidth: 180 },
  id: { flex: 3, minWidth: 200 },
} as const;

/** The deadline, and whether it was missed: the one thing a merchant must not overlook. */
function Deadline({ dispute }: { dispute: Dispute }) {
  const { due_by, past_due, submission_count } = dispute.evidence_details;
  if (submission_count >= 1) {
    return (
      <Text variant="body-2-regular" className="text-muted-foreground">
        {t('disputes.responded')}
      </Text>
    );
  }
  if (due_by === null) return <Text variant="body-2-regular">—</Text>;
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Text variant="body-2-regular">{formatInstant(due_by)}</Text>
      {past_due ? (
        <Badge
          appearance="subtle"
          tone="danger"
          size="label-small"
          content={t('disputes.pastDue')}
        />
      ) : null}
    </View>
  );
}

function DisputesTable({ disputes }: { disputes: readonly Dispute[] }) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('disputes.title')} minWidth={820}>
      <TableHeader>
        <TableColumn {...COLUMNS.amount}>{t('disputes.column.amount')}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('disputes.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.reason}>{t('disputes.column.reason')}</TableColumn>
        <TableColumn {...COLUMNS.due}>{t('disputes.column.due')}</TableColumn>
        <TableColumn {...COLUMNS.id}>{t('disputes.column.id')}</TableColumn>
      </TableHeader>
      <TableBody
        emptyState={
          <EmptyState
            variant="compact"
            title={t('disputes.empty.title')}
            description={t('disputes.empty.body')}
          />
        }
      >
        {disputes.map((dispute) => (
          <RowLink
            key={dispute.id}
            accessibilityLabel={`${t('dispute.title')} ${dispute.id}`}
            onPress={() => router.push({ pathname: '/disputes/[id]', params: { id: dispute.id } })}
          >
            <TableRow>
              <TableCell {...COLUMNS.amount}>
                {formatAmount(dispute.amount, dispute.currency)}
              </TableCell>
              <TableCell {...COLUMNS.status}>
                <DisputeStatusBadge status={dispute.status} />
              </TableCell>
              <TableCell {...COLUMNS.reason}>{disputeReasonLabel(dispute.reason)}</TableCell>
              <TableCell {...COLUMNS.due}>
                <Deadline dispute={dispute} />
              </TableCell>
              <TableCell {...COLUMNS.id}>
                <Text
                  variant="body-2-regular"
                  numberOfLines={1}
                  className="font-mono text-muted-foreground"
                >
                  {dispute.id}
                </Text>
              </TableCell>
            </TableRow>
          </RowLink>
        ))}
      </TableBody>
    </Table>
  );
}

function DisputeList({ scope }: { scope: DashboardScope }) {
  const pages = useDisputePages(scope);
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('disputes.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const disputes = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <DisputesTable disputes={disputes} />
      <ListFooter pages={pages} />
    </View>
  );
}

export default function DisputesScreen() {
  return (
    <OrbitScreen title={t('disputes.title')} description={t('disputes.intro')}>
      {({ scope }) => <DisputeList scope={scope} />}
    </OrbitScreen>
  );
}
