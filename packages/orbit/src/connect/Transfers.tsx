import { EmptyState } from '@oxy.so/bloom/empty-state';
import { type DashboardScope, isMerchantMissing } from '../api/dashboard';
import { t } from '../i18n';
import { ErrorNotice, ListFooter, Section } from '../ui/OrbitScreen';
import { TransferRow } from './TransferRow';
import { useTransferPages } from './useConnect';
import { PageSkeleton } from '../ui/states';

/** Every settlement paid to a seller, or one seller's when `seller` is given. */
export function Transfers({ scope, seller }: { scope: DashboardScope; seller: string | null }) {
  const pages = useTransferPages(scope, seller);
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('connect.transfers')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return null;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const transfers = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('connect.transfers')} description={t('connect.transfersIntro')}>
      {transfers.length ? (
        transfers.map((transfer) => (
          <TransferRow key={transfer.id} scope={scope} transfer={transfer} showSeller={!seller} />
        ))
      ) : (
        <EmptyState
          variant="compact"
          title={t('connect.transfers.empty.title')}
          description={t('connect.transfers.empty.body')}
        />
      )}
      <ListFooter pages={pages} />
    </Section>
  );
}
