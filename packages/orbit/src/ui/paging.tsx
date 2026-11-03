import { View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@oxy.so/bloom/button';
import type { ListPage } from '../api/dashboard';
import { t } from '../i18n';

/** A Peable list walked with `starting_after` = the last id of the page before, while `has_more`. */
export function usePagedList<T extends { id: string }>(
  queryKey: readonly unknown[],
  fetchPage: (startingAfter: string | undefined) => Promise<ListPage<T>>,
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (last: ListPage<T>) =>
      last.has_more ? last.data[last.data.length - 1]?.id : undefined,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
}

/** "Load more", shown only while the list says there is more. */
export function LoadMore({
  pages,
}: {
  pages: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  if (!pages.hasNextPage) return null;
  return (
    <View className="items-center pt-2">
      <Button
        appearance="outline"
        loading={pages.isFetchingNextPage}
        onPress={() => void pages.fetchNextPage()}
      >
        {t('action.loadMore')}
      </Button>
    </View>
  );
}
