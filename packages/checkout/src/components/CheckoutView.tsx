import { useEffect, useState } from 'react';
import type { MerchantDisplay, PaymentIntent } from '@peable.to/shared-types';
import { getPaymentIntent, subscribe } from '../lib/intentClient';
import { MerchantIdentity } from './MerchantIdentity';
import { PayWithPeable, isChainIntent } from './PayWithPeable';
import { StatusPanel } from './StatusPanel';

export interface CheckoutViewProps {
  /** The initial REST snapshot (already loaded by the route) — the first
   * frame; the realtime subscription below supplies every update after it. */
  intent: PaymentIntent;
  /** Only `/l/:linkId` and `/c/:sessionId` have merchant identity available —
   * `/i/:intentId`'s own DTO carries just `merchantId`, not a display object. */
  merchant?: MerchantDisplay;
  /** Only the checkout-session flow (`/c/:sessionId`) has a redirect target. */
  successUrl?: string;
}

const AWAITING_PAYMENT_STATUSES: ReadonlySet<PaymentIntent['status']> = new Set([
  'created',
  'awaiting_approval',
]);

/**
 * Statuses nothing can follow — the fallback poller stops here rather than
 * re-reading a row that can no longer change.
 */
const TERMINAL_STATUSES: ReadonlySet<PaymentIntent['status']> = new Set([
  'settled',
  'expired',
  'failed',
  'rejected',
]);

/**
 * How often the REST fallback re-reads the intent when the realtime channel
 * could not be established. Slower than a socket by design: this is the
 * degraded path, and every payer on it costs the Gateway a request per tick.
 */
const FALLBACK_POLL_MS = 5_000;

export function CheckoutView({ intent: initialIntent, merchant, successUrl }: CheckoutViewProps) {
  const [intent, setIntent] = useState(initialIntent);
  /**
   * Set when `subscribe` rejects. Until this existed the failure was swallowed
   * and the payer sat on the initial REST snapshot forever — paying, and
   * watching a page that never acknowledged it.
   */
  const [realtimeUnavailable, setRealtimeUnavailable] = useState(false);

  // A fresh mint/reuse (LinkRoute) or a route re-navigation swaps the whole
  // intent identity — reset the locally-tracked live state to match.
  useEffect(() => {
    setIntent(initialIntent);
    setRealtimeUnavailable(false);
  }, [initialIntent]);

  // Subscribe on mount, unsubscribe on unmount (mirrors the wallet's
  // `subscriptionRef` cleanup, app/pay/[intent].tsx:188-193). The Gateway
  // accepts anonymous, token-less socket connections, authorizing each
  // subscribe by the intent's `client_secret` (the same capability the
  // wallet's own room-join relies on). When that channel cannot be opened the
  // effect below takes over with a REST poll.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    subscribe(initialIntent.id, initialIntent.clientSecret, (updated) => {
      if (!cancelled) setIntent(updated);
    })
      .then((unsub) => {
        if (cancelled) {
          unsub();
          return;
        }
        unsubscribe = unsub;
      })
      .catch(() => {
        // Realtime is out. Hand over to the polling effect rather than leaving
        // the payer on a frozen snapshot.
        if (!cancelled) setRealtimeUnavailable(true);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [initialIntent.id, initialIntent.clientSecret]);

  // Degraded path only. Depends on `intent.status` so the interval is torn
  // down as soon as the intent reaches a state nothing can follow.
  useEffect(() => {
    if (!realtimeUnavailable) return;
    if (TERMINAL_STATUSES.has(intent.status)) return;

    let cancelled = false;
    const timer = setInterval(() => {
      getPaymentIntent(initialIntent.id, initialIntent.clientSecret)
        .then((updated) => {
          if (!cancelled) setIntent(updated);
        })
        .catch(() => {
          // A failed read is not terminal: the next tick retries. The payer
          // keeps seeing the last state the Gateway confirmed.
        });
    }, FALLBACK_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [realtimeUnavailable, intent.status, initialIntent.id, initialIntent.clientSecret]);

  const awaitingPayment = AWAITING_PAYMENT_STATUSES.has(intent.status);

  return (
    <div className="checkout-view">
      {merchant && <MerchantIdentity merchant={merchant} />}
      {awaitingPayment && isChainIntent(intent) ? (
        <PayWithPeable intent={intent} />
      ) : (
        // A card intent awaiting payment falls through to `StatusPanel` for
        // now: this page has no card surface yet, and showing a wallet QR for
        // a payment no wallet can make would be worse than showing its status.
        // The card branch belongs here, beside this one.
        <StatusPanel intent={intent} successUrl={successUrl} />
      )}
    </div>
  );
}
