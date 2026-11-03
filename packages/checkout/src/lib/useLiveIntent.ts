import { useEffect, useState } from 'react';
import type { PaymentIntent } from '@peable.to/shared-types';
import { getPaymentIntent, subscribe } from './intentClient';

/**
 * Statuses nothing can follow — the fallback poller stops here rather than
 * re-reading a row that can no longer change.
 */
const TERMINAL_STATUSES: ReadonlySet<PaymentIntent['status']> = new Set(['succeeded', 'canceled']);

/**
 * How often the REST fallback re-reads the intent when the realtime channel
 * could not be established. Slower than a socket by design: this is the
 * degraded path, and every payer on it costs the Gateway a request per tick.
 */
export const FALLBACK_POLL_MS = 5_000;

/**
 * The payment as the GATEWAY currently says it is: the initial snapshot, then
 * every realtime update (`subscribe`), with a REST poll whenever the socket is
 * unavailable or dropped. One implementation for the intent page and the
 * session page, so both recover from a lost socket the same way.
 */
export function useLiveIntent(initialIntent: PaymentIntent): PaymentIntent {
  const [intent, setIntent] = useState(initialIntent);
  /**
   * Set when `subscribe` rejects or the socket drops. Until this existed the
   * failure was swallowed and the payer sat on the initial REST snapshot
   * forever — paying, and watching a page that never acknowledged it.
   */
  const [realtimeUnavailable, setRealtimeUnavailable] = useState(false);

  // A new payment identity resets the locally tracked live state.
  useEffect(() => {
    setIntent(initialIntent);
    setRealtimeUnavailable(false);
  }, [initialIntent]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    subscribe(
      initialIntent.id,
      initialIntent.client_secret,
      (updated) => {
        if (!cancelled) setIntent(updated);
      },
      (state) => {
        if (cancelled) return;
        if (state === 'lost') {
          setRealtimeUnavailable(true);
          return;
        }
        // Re-read BEFORE standing the poll down: socket.io replays nothing, so
        // every update emitted during the outage is gone.
        getPaymentIntent(initialIntent.id, initialIntent.client_secret)
          .then((updated) => {
            if (cancelled) return;
            setIntent(updated);
            setRealtimeUnavailable(false);
          })
          .catch(() => {
            // Keep polling; the fallback covers a failed read.
          });
      },
    )
      .then((unsub) => {
        if (cancelled) {
          unsub();
          return;
        }
        unsubscribe = unsub;
      })
      .catch(() => {
        if (!cancelled) setRealtimeUnavailable(true);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [initialIntent.id, initialIntent.client_secret]);

  useEffect(() => {
    if (!realtimeUnavailable) return;
    if (TERMINAL_STATUSES.has(intent.status)) return;
    let cancelled = false;
    const timer = setInterval(() => {
      getPaymentIntent(initialIntent.id, initialIntent.client_secret)
        .then((updated) => {
          if (!cancelled) setIntent(updated);
        })
        .catch(() => {
          // A failed read is not terminal: the next tick retries.
        });
    }, FALLBACK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [realtimeUnavailable, intent.status, initialIntent.id, initialIntent.client_secret]);

  return intent;
}
