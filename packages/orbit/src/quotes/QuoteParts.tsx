import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Quote, QuoteStatus } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@oxy.so/bloom/table';
import { Text } from '@oxy.so/bloom/typography';
import { formatSignedAmount } from '../billing/amount';
import { refId } from '../billing/BillingParts';
import { labelFor, t } from '../i18n';
import { AmountText, RowLink, Timestamp } from '../ui/data';
import { quoteStatusTone } from './quoteForm';

export function quoteStatusLabel(status: QuoteStatus): string {
  return labelFor('quoteStatus', status);
}

export function QuoteStatusBadge({ status }: { status: QuoteStatus }) {
  return (
    <Badge
      appearance="subtle"
      tone={quoteStatusTone(status)}
      size="label-small"
      content={quoteStatusLabel(status)}
    />
  );
}

const COLUMNS = {
  total: { flex: 2, minWidth: 120, align: 'end' },
  status: { flex: 2, minWidth: 120 },
  number: { flex: 2, minWidth: 160 },
  customer: { flex: 2, minWidth: 160 },
  expires: { flex: 2, minWidth: 130 },
  created: { flex: 2, minWidth: 130 },
} as const;

/** Quotes, Stripe's table: total on the right, status, number, customer, expiry, created; a row opens it. */
export function QuotesTable({ quotes, empty }: { quotes: readonly Quote[]; empty?: ReactNode }) {
  const router = useRouter();
  return (
    <Table accessibilityLabel={t('quotes.title')} minWidth={820} size="sm">
      <TableHeader>
        <TableColumn {...COLUMNS.total}>{t('list.column.total')}</TableColumn>
        <TableColumn {...COLUMNS.status}>{t('list.column.status')}</TableColumn>
        <TableColumn {...COLUMNS.number}>{t('list.column.number')}</TableColumn>
        <TableColumn {...COLUMNS.customer}>{t('list.column.customer')}</TableColumn>
        <TableColumn {...COLUMNS.expires}>{t('quotes.column.expires')}</TableColumn>
        <TableColumn {...COLUMNS.created}>{t('list.column.created')}</TableColumn>
      </TableHeader>
      <TableBody emptyState={empty}>
        {quotes.map((quote) => (
          <RowLink
            key={quote.id}
            accessibilityLabel={`${t('quote.title')} ${quote.number ?? quote.id}`}
            onPress={() => router.push({ pathname: '/quotes/[id]', params: { id: quote.id } })}
          >
            <TableRow>
              <TableCell {...COLUMNS.total}>
                <AmountText strong>
                  {formatSignedAmount(quote.amount_total, quote.currency)}
                </AmountText>
              </TableCell>
              <TableCell {...COLUMNS.status}>
                <QuoteStatusBadge status={quote.status} />
              </TableCell>
              <TableCell {...COLUMNS.number}>
                <View>
                  <Text variant="body-2-regular" numberOfLines={1} className="font-mono">
                    {quote.number ?? t('quote.draftNumber')}
                  </Text>
                  {quote.header ? (
                    <Text
                      variant="caption-1-regular"
                      numberOfLines={1}
                      className="text-muted-foreground"
                    >
                      {quote.header}
                    </Text>
                  ) : null}
                </View>
              </TableCell>
              <TableCell {...COLUMNS.customer}>
                <Text variant="body-2-regular" numberOfLines={1} className="font-mono">
                  {refId(quote.customer as string | { id: string }) ?? '—'}
                </Text>
              </TableCell>
              <TableCell {...COLUMNS.expires}>
                <Timestamp seconds={quote.expires_at} muted />
              </TableCell>
              <TableCell {...COLUMNS.created}>
                <Timestamp seconds={quote.created} muted />
              </TableCell>
            </TableRow>
          </RowLink>
        ))}
      </TableBody>
    </Table>
  );
}
