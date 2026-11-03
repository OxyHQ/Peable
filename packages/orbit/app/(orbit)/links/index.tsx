import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { PaymentLink } from '@peable.to/shared-types';
import { Badge } from '@oxy.so/bloom/badge';
import { Button, LinkButton } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { isMerchantMissing, type DashboardScope } from '@/api/dashboard';
import { formatInstant } from '@/format/time';
import { t } from '@/i18n';
import { linkSummary } from '@/links/linkForm';
import { LinkShare } from '@/links/LinkShare';
import { type LinkFilter, useLinkPages } from '@/links/useLinks';
import { Choice } from '@/ui/Choice';
import { ErrorNotice, MerchantMissing, OrbitScreen, Section } from '@/ui/OrbitScreen';

const filterOptions = () => [
  { value: 'active', label: t('links.filter.active') },
  { value: 'inactive', label: t('links.filter.inactive') },
  { value: 'all', label: t('links.filter.all') },
];

function filterValue(filter: LinkFilter): string {
  return filter === null ? 'all' : filter ? 'active' : 'inactive';
}

function LinkRow({ link }: { link: PaymentLink }) {
  const router = useRouter();
  return (
    <View className="gap-2 py-3 border-b border-border">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge
          appearance="subtle"
          tone={link.active ? 'success' : 'neutral'}
          size="label-small"
          content={link.active ? t('links.active') : t('links.inactive')}
        />
        <LinkButton
          size="sm"
          accessibilityLabel={`${t('link.title')} ${linkSummary(link)}`}
          onPress={() => router.push({ pathname: '/links/[id]', params: { id: link.id } })}
        >
          {linkSummary(link) || link.id}
        </LinkButton>
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        <Text variant="caption-1-regular" selectable className="text-muted-foreground font-mono">
          {link.id}
        </Text>
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {link.currency}
        </Text>
        {link.restrictions ? (
          <Text variant="caption-1-regular" className="text-muted-foreground">
            {t('links.sessionsCount', {
              count: link.restrictions.completed_sessions.count,
              limit: link.restrictions.completed_sessions.limit,
            })}
          </Text>
        ) : null}
        <Text variant="caption-1-regular" className="text-muted-foreground">
          {formatInstant(link.created)}
        </Text>
      </View>
      <LinkShare url={link.url} />
    </View>
  );
}

function LinkList({ scope, filter }: { scope: DashboardScope; filter: LinkFilter }) {
  const pages = useLinkPages(scope, filter);
  if (pages.isPending) return <Loading accessibilityLabel={t('links.title')} />;
  if (pages.isError) {
    if (isMerchantMissing(pages.error)) return <MerchantMissing environment={scope.environment} />;
    return <ErrorNotice error={pages.error} onRetry={() => void pages.refetch()} />;
  }
  const links = pages.data.pages.flatMap((page) => page.data);
  return (
    <Section title={t('links.title')}>
      {links.length ? (
        links.map((link) => <LinkRow key={link.id} link={link} />)
      ) : (
        <EmptyState
          variant="compact"
          title={t('links.empty.title')}
          description={t('links.empty.body')}
        />
      )}
      {pages.hasNextPage ? (
        <View className="items-center pt-2">
          <Button
            appearance="outline"
            loading={pages.isFetchingNextPage}
            onPress={() => void pages.fetchNextPage()}
          >
            {t('action.loadMore')}
          </Button>
        </View>
      ) : null}
    </Section>
  );
}

export default function PaymentLinksScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<LinkFilter>(true);
  return (
    <OrbitScreen
      title={t('links.title')}
      description={t('links.description')}
      actions={
        <View className="flex-row flex-wrap items-end gap-3">
          <View className="w-56">
            <Choice
              size="sm"
              label={t('links.filter')}
              value={filterValue(filter)}
              options={filterOptions()}
              onChange={(next) => setFilter(next === 'all' ? null : next === 'active')}
            />
          </View>
          <Button appearance="solid" tone="accent" onPress={() => router.push('/links/new')}>
            {t('links.new')}
          </Button>
        </View>
      }
    >
      {({ scope }) => <LinkList scope={scope} filter={filter} />}
    </OrbitScreen>
  );
}
