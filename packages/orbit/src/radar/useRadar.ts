import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { RadarRule, RadarRuleAction, Review } from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';

export const RULES_PAGE_SIZE = 50;
export const REVIEWS_PAGE_SIZE = 25;
/** How long the editor waits after the last keystroke before asking the gateway. */
export const VALIDATE_DEBOUNCE_MS = 400;

/**
 * Risk rules' and reviews' queries (ADR 0022), scoped like every Orbit key so
 * a mode switch never shows the other mode's rules. Invalidating `all` after a
 * review closes refreshes the queue and every evaluation list.
 */
export const radarKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'radar'],
  rules: (scope: DashboardScope, action: string) => [...radarKeys.all(scope), 'rules', action],
  rule: (scope: DashboardScope, id: string) => [...radarKeys.all(scope), 'rule', id],
  validate: (scope: DashboardScope, predicate: string) => [
    ...radarKeys.all(scope),
    'validate',
    predicate,
  ],
  evaluations: (scope: DashboardScope, paymentIntent: string) => [
    ...radarKeys.all(scope),
    'evaluations',
    paymentIntent,
  ],
  reviews: (scope: DashboardScope, open: boolean) => [
    ...radarKeys.all(scope),
    'reviews',
    open ? 'open' : 'closed',
  ],
  review: (scope: DashboardScope, id: string) => [...radarKeys.all(scope), 'review', id],
};

const nextCursor = <T extends { id: string }>(last: ListPage<T>) =>
  last.has_more ? last.data[last.data.length - 1]?.id : undefined;

export function useRulePages(scope: DashboardScope, action: RadarRuleAction | null) {
  return useInfiniteQuery({
    queryKey: radarKeys.rules(scope, action ?? 'all'),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.radar.rules.list(scope, {
        limit: RULES_PAGE_SIZE,
        ...(action ? { action } : {}),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<RadarRule>) => nextCursor(last),
  });
}

export function useRule(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: radarKeys.rule(scope, id),
    queryFn: () => dashboardApi.radar.rules.retrieve(scope, id),
  });
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The gateway's verdict on the predicate as typed, asked once the typing
 * stops. `checked` is the text the answer is for: the editor never shows an
 * answer for older text as the answer for what is in the field now.
 */
export function usePredicateCheck(scope: DashboardScope, predicate: string) {
  const checked = useDebouncedValue(predicate.trim(), VALIDATE_DEBOUNCE_MS);
  const query = useQuery({
    queryKey: radarKeys.validate(scope, checked),
    queryFn: () => dashboardApi.radar.rules.validate(scope, checked),
    enabled: checked.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return { checked, query };
}

/** The rule evaluations of one payment: what explains a decline or a review. */
export function usePaymentEvaluations(scope: DashboardScope, paymentIntent: string) {
  return useQuery({
    queryKey: radarKeys.evaluations(scope, paymentIntent),
    queryFn: () =>
      dashboardApi.radar.evaluations.list(scope, { payment_intent: paymentIntent, limit: 100 }),
  });
}

export function useReviewPages(scope: DashboardScope, open: boolean) {
  return useInfiniteQuery({
    queryKey: radarKeys.reviews(scope, open),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.reviews.list(scope, {
        open,
        limit: REVIEWS_PAGE_SIZE,
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<Review>) => nextCursor(last),
  });
}

export function useReview(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: radarKeys.review(scope, id),
    queryFn: () => dashboardApi.reviews.retrieve(scope, id),
  });
}
