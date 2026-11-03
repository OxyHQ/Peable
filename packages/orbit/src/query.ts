import { QueryClient } from '@tanstack/react-query';

/**
 * The one TanStack Query client: `OxyProvider` shares it with the SDK's own
 * queries, and every Orbit read goes through it. Merchant data changes under
 * the merchant's feet (a webhook retried, a payment settled), so it goes stale
 * quickly and is refetched when the window regains focus.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // A 4xx is an answer, not an outage: retrying a 403 or a 404 only
        // delays telling the merchant what the gateway said.
        const status = (error as { status?: unknown } | null)?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
    },
  },
});
