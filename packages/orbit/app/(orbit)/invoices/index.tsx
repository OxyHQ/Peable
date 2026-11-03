import { useState } from 'react';
import { View } from 'react-native';
import type { InvoiceStatus } from '@peable.to/shared-types';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { InvoicesTable } from '@/billing/BillingParts';
import { invoiceStatusLabel, ORBIT_INVOICE_STATUSES } from '@/billing/status';
import { useInvoicePages } from '@/billing/useBilling';
import { t } from '@/i18n';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, ListFooter, MerchantMissing, OrbitScreen } from '@/ui/OrbitScreen';
import { ListEmpty, PageSkeleton } from '@/ui/states';

const ALL = 'all';
// Built at render: the language can change while Orbit is open.
const options = () => [
  { value: ALL, label: t('invoices.filter.all') },
  ...ORBIT_INVOICE_STATUSES.map((status) => ({ value: status, label: invoiceStatusLabel(status) })),
];

function InvoiceList({ scope, status }: { scope: DashboardScope; status: InvoiceStatus | null }) {
  const pages = useInvoicePages(scope, status);
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('invoices.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const rows = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <InvoicesTable
        invoices={rows}
        empty={
          status ? (
            <EmptyState
              variant="compact"
              title={t('invoices.empty.title')}
              description={t('invoices.empty.body')}
            />
          ) : (
            <ListEmpty
              title={t('invoices.empty.firstTitle')}
              description={t('invoices.empty.firstBody')}
              docs="billing"
            />
          )
        }
      />
      <ListFooter pages={pages} />
    </View>
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
