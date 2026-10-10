/**
 * The single app-wide TanStack Query client and its React Native focus wiring.
 *
 * This is the foundation of the app's data layer: every server-derived value
 * (the Explorer market data today, more services later) flows through this one
 * client so caching, request de-duplication, and background revalidation live
 * in a single place. The Explorer realtime socket (`explorer-socket.ts`) writes
 * straight into this cache via `setQueryData`/`invalidateQueries`, so a live
 * block push re-renders the relevant `useQuery` observers without any polling.
 *
 * Zustand remains the app's client-state layer (wallet-store, lock-store, …);
 * this client owns only *server* state.
 */

import { AppState, Platform } from 'react-native';
import { QueryClient, focusManager } from '@tanstack/react-query';

/** How long a fetched value is considered fresh before a background refetch. */
const DEFAULT_STALE_TIME_MS = 30_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: DEFAULT_STALE_TIME_MS,
      refetchOnWindowFocus: true,
      // One retry on failure, then surface the error; React Query keeps serving
      // the last successful data while a refetch is failing.
      retry: 1,
    },
  },
});

// React Query's built-in focus tracking listens to DOM visibility events, which
// don't exist on native. Bridge `refetchOnWindowFocus` to React Native's
// AppState so returning to the foreground revalidates active queries. Web keeps
// React Query's default (document visibility) listener.
if (Platform.OS !== 'web') {
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener('change', (status) => {
      handleFocus(status === 'active');
    });
    return () => subscription.remove();
  });
}
