import { useState } from 'react';
import { View } from 'react-native';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { t } from '@/i18n';
import { ReviewCard } from '@/radar/ReviewParts';
import { useReviewPages } from '@/radar/useRadar';
import { useDashboardPermissions } from '@/scope/useDashboardPermissions';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, ListFooter, SetupPayments, OrbitScreen } from '@/ui/OrbitScreen';
import { PageSkeleton, PermissionNotice } from '@/ui/states';

type QueueFilter = 'open' | 'closed';

// Built at render: the language can change while Orbit is open.
const options = () => [
  { value: 'open', label: t('reviews.filter.open') },
  { value: 'closed', label: t('reviews.filter.closed') },
];

function ReviewQueue({ scope, open }: { scope: DashboardScope; open: boolean }) {
  const { can } = useDashboardPermissions();
  const pages = useReviewPages(scope, open);
  if (pages.isPending)
    return <PageSkeleton variant="table" accessibilityLabel={t('reviews.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <SetupPayments environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const reviews = pages.data.pages.flatMap((page) => page.data);
  if (!reviews.length) {
    return (
      <EmptyState
        variant="compact"
        title={open ? t('reviews.empty.openTitle') : t('reviews.empty.closedTitle')}
        description={open ? t('reviews.empty.openBody') : t('reviews.empty.closedBody')}
      />
    );
  }
  return (
    <View className="gap-4">
      {open && !can('money') ? <PermissionNotice action="money" /> : null}
      <View>
        {reviews.map((review) => (
          <ReviewCard key={review.id} scope={scope} review={review} />
        ))}
      </View>
      <ListFooter pages={pages} />
    </View>
  );
}

export default function ReviewsScreen() {
  const [filter, setFilter] = useState<QueueFilter>('open');
  return (
    <OrbitScreen
      title={t('reviews.title')}
      description={t('reviews.description')}
      filters={
        <View className="w-56">
          <Choice
            size="sm"
            label={t('reviews.filter')}
            value={filter}
            options={options()}
            onChange={(next) => setFilter(next === 'closed' ? 'closed' : 'open')}
          />
        </View>
      }
    >
      {({ scope }) => <ReviewQueue scope={scope} open={filter === 'open'} />}
    </OrbitScreen>
  );
}
