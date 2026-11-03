import { useState } from 'react';
import { View } from 'react-native';
import type { PaymentIntentStatus } from '@peable.to/shared-types';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { t } from '@/i18n';
import { PaymentsTable } from '@/payments/PaymentsTable';
import { ORBIT_PAYMENT_STATUSES, paymentStatusLabel } from '@/payments/status';
import { usePaymentPages } from '@/payments/usePayments';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, ListFooter, MerchantMissing, OrbitScreen } from '@/ui/OrbitScreen';

const ALL = 'all';
const statusOptions = () => [
  { value: ALL, label: t('payments.allStatuses') },
  ...ORBIT_PAYMENT_STATUSES.map((status) => ({ value: status, label: paymentStatusLabel(status) })),
];

function StatusFilter({
  value,
  onChange,
}: {
  value: PaymentIntentStatus | null;
  onChange: (status: PaymentIntentStatus | null) => void;
}) {
  return (
    <View className="w-56">
      <Choice
        size="sm"
        label={t('payments.filter')}
        value={value ?? ALL}
        options={statusOptions()}
        onChange={(next) => onChange(next === ALL ? null : (next as PaymentIntentStatus))}
      />
    </View>
  );
}

function PaymentList({
  scope,
  status,
}: {
  scope: DashboardScope;
  status: PaymentIntentStatus | null;
}) {
  const pages = usePaymentPages(scope, status);
  if (pages.isPending) return <Loading accessibilityLabel={t('payments.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const payments = pages.data.pages.flatMap((page) => page.data);
  return (
    <View className="gap-4">
      <PaymentsTable
        payments={payments}
        empty={
          <EmptyState
            variant="compact"
            title={t('payments.empty.title')}
            description={t('payments.empty.body')}
          />
        }
      />
      <ListFooter pages={pages} />
    </View>
  );
}

export default function PaymentsScreen() {
  const [status, setStatus] = useState<PaymentIntentStatus | null>(null);
  return (
    <OrbitScreen
      title={t('payments.title')}
      filters={<StatusFilter value={status} onChange={setStatus} />}
    >
      {({ scope }) => <PaymentList scope={scope} status={status} />}
    </OrbitScreen>
  );
}
