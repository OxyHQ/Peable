import { useRouter } from 'expo-router';
import type { PaymentIntent } from '@peable.to/shared-types';
import { LinkButton } from '@oxy.so/bloom/button';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { formatAmount } from '../format/money';
import { formatInstant } from '../format/time';
import { t } from '../i18n';
import { PaymentStatusBadge } from '../ui/StatusBadge';

/** Columns, shared by header and rows so the two cannot disagree. */
const COLUMNS = {
  amount: { flex: 2, minWidth: 140 },
  status: { flex: 2, minWidth: 140 },
  rail: { flex: 1, minWidth: 90 },
  id: { flex: 3, minWidth: 200 },
  created: { flex: 2, minWidth: 160 },
} as const;

export function PaymentsTable({
  payments,
  empty,
}: {
  payments: readonly PaymentIntent[];
  empty?: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('payments.title')} minWidth={760}>
      <TableHeader>
        <TableColumn {...COLUMNS.amount}>{t('payments.column.amount')}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('payments.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.rail}>{t('payments.column.rail')}</TableColumn>
        <TableColumn {...COLUMNS.id}>{t('payments.column.id')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('payments.column.created')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {payments.map((payment) => (
          <TableRow key={payment.id}>
            <TableCell {...COLUMNS.amount}>
              {formatAmount(payment.amount, payment.currency)}
            </TableCell>
            <TableCell {...COLUMNS.status}>
              <PaymentStatusBadge status={payment.status} />
            </TableCell>
            <TableCell {...COLUMNS.rail}>{t(`payments.rail.${payment.rail}`)}</TableCell>
            <TableCell {...COLUMNS.id}>
              <LinkButton
                size="sm"
                accessibilityLabel={`${t('payment.title')} ${payment.id}`}
                onPress={() =>
                  router.push({ pathname: '/payments/[id]', params: { id: payment.id } })
                }
              >
                {payment.id}
              </LinkButton>
            </TableCell>
            <TableCell {...COLUMNS.created}>{formatInstant(payment.created)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
