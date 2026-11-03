import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import type { Payout } from '@peable.to/shared-types';
import { LinkButton } from '@oxy.so/bloom/button';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { formatSignedAmount } from '../format/money';
import { formatInstant } from '../format/time';
import { t } from '../i18n';
import { PayoutStatusBadge } from '../ui/StatusBadge';

const COLUMNS = {
  amount: { flex: 2, minWidth: 140 },
  status: { flex: 2, minWidth: 130 },
  arrival: { flex: 2, minWidth: 160 },
  method: { flex: 2, minWidth: 140 },
  id: { flex: 3, minWidth: 200 },
  created: { flex: 2, minWidth: 160 },
} as const;

export function PayoutsTable({
  payouts,
  empty,
}: {
  payouts: readonly Payout[];
  empty?: ReactNode;
}) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('payouts.list')} minWidth={940}>
      <TableHeader>
        <TableColumn {...COLUMNS.amount}>{t('payouts.column.amount')}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('payouts.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.arrival}>{t('payouts.column.arrival')}</TableColumn>
        <TableColumn {...COLUMNS.method}>{t('payouts.column.method')}</TableColumn>
        <TableColumn {...COLUMNS.id}>{t('payouts.column.id')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('payouts.column.created')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {payouts.map((payout) => (
          <TableRow key={payout.id}>
            <TableCell {...COLUMNS.amount}>
              {formatSignedAmount(payout.amount, payout.currency)}
            </TableCell>
            <TableCell {...COLUMNS.status}>
              <PayoutStatusBadge status={payout.status} />
            </TableCell>
            <TableCell {...COLUMNS.arrival}>{formatInstant(payout.arrival_date)}</TableCell>
            <TableCell {...COLUMNS.method}>
              {`${t(`payout.method.${payout.method}`)} · ${t(
                payout.automatic ? 'payout.origin.automatic' : 'payout.origin.manual',
              )}`}
            </TableCell>
            <TableCell {...COLUMNS.id}>
              <LinkButton
                size="sm"
                accessibilityLabel={`${t('payout.title')} ${payout.id}`}
                onPress={() =>
                  router.push({ pathname: '/payouts/[id]', params: { id: payout.id } })
                }
              >
                {payout.id}
              </LinkButton>
            </TableCell>
            <TableCell {...COLUMNS.created}>{formatInstant(payout.created)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
