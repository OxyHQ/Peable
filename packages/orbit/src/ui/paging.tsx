import { useInfiniteQuery } from '@tanstack/react-query';
import type { ListPage } from '../api/dashboard';

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
