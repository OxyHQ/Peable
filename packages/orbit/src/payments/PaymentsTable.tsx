import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import type { PaymentIntent } from '@peable.to/shared-types';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { Text } from '@oxy.so/bloom/typography';
import { formatAmountValue } from '../format/money';
import { t } from '../i18n';
import { AmountText, RowLink, Timestamp } from '../ui/data';
import { PaymentStatusBadge } from '../ui/StatusBadge';

/** Columns, shared by header and rows so the two cannot disagree. Stripe's order. */
const COLUMNS = {
  amount: { flex: 2, minWidth: 120, align: 'end' },
  currency: { width: 64 },
  status: { flex: 2, minWidth: 130 },
  method: { flex: 1, minWidth: 90 },
  description: { flex: 3, minWidth: 200 },
  created: { flex: 2, minWidth: 140 },
} as const;

/** What a payment row says it is: its description, else its id. */
function describe(payment: PaymentIntent): { text: string; mono: boolean } {
  return payment.description
    ? { text: payment.description, mono: false }
    : { text: payment.id, mono: true };
}

/** Payments, Stripe's dense table: amount on the right, status, method, what it was for, date; a row opens it. */
export function PaymentsTable({
  payments,
  empty,
}: {
  payments: readonly PaymentIntent[];
  empty?: ReactNode;
}) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('payments.title')} minWidth={720} size="sm">
      <TableHeader>
        <TableColumn {...COLUMNS.amount}>{t('payments.column.amount')}</TableColumn>
        <TableColumn {...COLUMNS.currency}>{''}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('payments.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.method}>{t('payments.column.rail')}</TableColumn>
        <TableColumn {...COLUMNS.description}>{t('payments.column.description')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('payments.column.created')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {payments.map((payment) => {
          const what = describe(payment);
          return (
            <RowLink
              key={payment.id}
              accessibilityLabel={`${t('payment.title')} ${payment.id}`}
              onPress={() =>
                router.push({ pathname: '/payments/[id]', params: { id: payment.id } })
              }
            >
              <TableRow>
                <TableCell {...COLUMNS.amount}>
                  <AmountText strong>
                    {formatAmountValue(payment.amount, payment.currency) ?? payment.amount}
                  </AmountText>
                </TableCell>
                <TableCell {...COLUMNS.currency}>
                  <Text variant="body-2-regular" className="text-muted-foreground">
                    {payment.currency.toUpperCase()}
                  </Text>
                </TableCell>
                <TableCell {...COLUMNS.status}>
                  <PaymentStatusBadge status={payment.status} />
                </TableCell>
                <TableCell {...COLUMNS.method}>{t(`payments.rail.${payment.rail}`)}</TableCell>
                <TableCell {...COLUMNS.description}>
                  <Text
                    variant="body-2-regular"
                    numberOfLines={1}
                    className={what.mono ? 'font-mono text-muted-foreground' : undefined}
                  >
                    {what.text}
                  </Text>
                </TableCell>
                <TableCell {...COLUMNS.created}>
                  <Timestamp seconds={payment.created} muted />
                </TableCell>
              </TableRow>
            </RowLink>
          );
        })}
      </TableBody>
    </Table>
  );
}
