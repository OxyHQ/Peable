import { useState } from 'react';
import { View } from 'react-native';
import type { InvoiceStatus } from '@peable.to/shared-types';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { InvoiceRow } from '@/billing/BillingParts';
import { invoiceStatusLabel, ORBIT_INVOICE_STATUSES } from '@/billing/status';
import { useInvoicePages } from '@/billing/useBilling';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, ListFooter, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';

const ALL = 'all';
// Built at render: the language can change while Orbit is open.
const options = () => [
  { value: ALL, label: t('invoices.filter.all') },
  ...ORBIT_INVOICE_STATUSES.map((status) => ({ value: status, label: invoiceStatusLabel(status) })),
];

function InvoiceList({ scope, status }: { scope: DashboardScope; status: InvoiceStatus | null }) {
  const pages = useInvoicePages(scope, status);
  if (pages.isPending) return <Loading accessibilityLabel={t('invoices.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('invoices.title')}>
      {rows.length ? (
        rows.map((row) => <InvoiceRow key={row.id} invoice={row} />)
      ) : (
        <EmptyState
          variant="compact"
          title={t('invoices.empty.title')}
          description={t('invoices.empty.body')}
        />
      )}
      <ListFooter pages={pages} />
    </Section>
  );
}

export default function InvoicesScreen() {
  const [status, setStatus] = useState<InvoiceStatus | null>(null);
  return (
    <OrbitScreen
      title={t('invoices.title')}
      description={t('invoices.description')}
      filters={
        <View className="w-56">
          <Choice
            size="sm"
            label={t('invoices.filter')}
            value={status ?? ALL}
            options={options()}
            onChange={(next) => setStatus(next === ALL ? null : (next as InvoiceStatus))}
          />
        </View>
      }
    >
      {({ scope }) => <InvoiceList scope={scope} status={status} />}
    </OrbitScreen>
  );
}
