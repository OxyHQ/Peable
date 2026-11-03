import type { ReactNode } from 'react';
import type { BalanceTransaction } from '@peable.to/shared-types';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { Text } from '@oxy.so/bloom/typography';
import { formatOptionalAmount, formatSignedAmount } from '../format/money';
import { t } from '../i18n';
import { BalanceTransactionStatusBadge } from '../ui/StatusBadge';
import { balanceTransactionTypeLabel } from './vocabulary';
import { Timestamp } from '../ui/data';

/** Columns, shared by header and rows so the two cannot disagree. */
const COLUMNS = {
  type: { flex: 2, minWidth: 150 },
  amount: { flex: 2, minWidth: 130, align: 'end' },
  fee: { flex: 2, minWidth: 120, align: 'end' },
  net: { flex: 2, minWidth: 130, align: 'end' },
  status: { flex: 2, minWidth: 130 },
  availableOn: { flex: 2, minWidth: 150 },
  created: { flex: 2, minWidth: 150 },
  source: { flex: 3, minWidth: 200 },
} as const;

/**
 * Balance transactions as the provider reported them. A fee or net it did not
 * report reads "Not reported" — never `0`, which is a number somebody would
 * subtract.
 */
export function BalanceTransactionsTable({
  transactions,
  empty,
}: {
  transactions: readonly BalanceTransaction[];
  empty?: ReactNode;
}) {
  const missing = t('money.notReported');
  return (
    <Table accessibilityLabel={t('balances.transactions')} minWidth={1160}>
      <TableHeader>
        <TableColumn {...COLUMNS.type}>{t('balances.column.type')}</TableColumn>
        <TableColumn {...COLUMNS.amount}>{t('balances.column.amount')}</TableColumn>
        <TableColumn {...COLUMNS.fee}>{t('balances.column.fee')}</TableColumn>
        <TableColumn {...COLUMNS.net}>{t('balances.column.net')}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('balances.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.availableOn}>{t('balances.column.availableOn')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('balances.column.created')}</TableColumn>
        <TableColumn {...COLUMNS.source}>{t('balances.column.source')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {transactions.map((txn) => (
          <TableRow key={txn.id}>
            <TableCell {...COLUMNS.type}>{balanceTransactionTypeLabel(txn.type)}</TableCell>
            <TableCell {...COLUMNS.amount}>
              {formatSignedAmount(txn.amount, txn.currency)}
            </TableCell>
            <TableCell {...COLUMNS.fee}>
              {formatOptionalAmount(txn.fee, txn.currency, missing)}
            </TableCell>
            <TableCell {...COLUMNS.net}>
              {formatOptionalAmount(txn.net, txn.currency, missing)}
            </TableCell>
            <TableCell {...COLUMNS.status}>
              <BalanceTransactionStatusBadge status={txn.status} />
            </TableCell>
            <TableCell {...COLUMNS.availableOn}>
              <Timestamp seconds={txn.available_on} muted />
            </TableCell>
            <TableCell {...COLUMNS.created}>
              <Timestamp seconds={txn.created} muted />
            </TableCell>
            <TableCell {...COLUMNS.source}>
              <Text variant="body-2-regular" selectable className="font-mono">
                {txn.source ?? '—'}
              </Text>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
