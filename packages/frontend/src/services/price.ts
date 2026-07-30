/**
 * Price service for FairCoin wallet.
 * Polls the Explorer API for current price data and caches it locally.
 */

import { z } from 'zod';
import { EXPLORER_BASE_URL } from '@fairco.in/core';

const EXPLORER_API = EXPLORER_BASE_URL;
const PRICE_POLL_INTERVAL = 60_000; // 1 minute

/**
 * `GET /api/price` on the wire.
 *
 * Mirrors `PricePayload` in the Explorer's `server/lib/price-service.ts`: a FLAT
 * `price` number, not a per-currency object. This parser used to read
 * `data.price.usd` and `data.change_24h.usd`, a shape the server has never
 * returned; because a number is truthy the `if (!data.price)` guard passed, and
 * every conversion downstream evaluated to `NaN` on real devices.
 *
 * Extra fields the app does not render (`volume24h`, `liquidityUsd`,
 * `marketCapUsd`, `source`) are stripped by Zod rather than declared, so the
 * server can add to the payload without breaking the wallet.
 *
 * `price` is nullable by contract — the route documents that it is `null` only
 * when every upstream source is unavailable — and `change24h` is legitimately
 * `0`, so neither may be treated as "missing" by truthiness.
 */
const priceResponseSchema = z.object({
  price: z.number().nullable(),
  change24h: z.number().nullable().default(null),
  updatedAt: z.string().optional(),
});

/**
 * The price as the app uses it.
 *
 * USD only: the endpoint quotes FAIR against USD and has no other currency in
 * it. The `eur` and `btc` fields this type used to carry were never populated
 * by any server response and were read by nothing.
 */
export interface PriceData {
  usd: number;
  change24h: number | null;
  timestamp: number;
}

let cachedPrice: PriceData | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let subscriberCount = 0;

// Change signal for `useSyncExternalStore`. Without it, a component reading
// `getCachedPrice()` during render reads module state the renderer knows
// nothing about — which the React Compiler is free to memoise, freezing the
// first price forever. Subscribing makes the read reactive and safe.
const listeners = new Set<() => void>();

/** Subscribe to price updates. Returns an unsubscribe function. */
export function subscribeToPrice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fetch the latest price from the Explorer API.
 * Returns cached value on network failure.
 */
export async function fetchPrice(): Promise<PriceData | null> {
  try {
    const response = await fetch(`${EXPLORER_API}/api/price`);
    if (!response.ok) return cachedPrice;

    const parsed = priceResponseSchema.safeParse(await response.json());
    // A body this build cannot read is treated exactly like an unreachable
    // server: keep the last good quote rather than publishing a broken one.
    // Unlike `market.ts` this fetcher never throws — it backs a
    // `useSyncExternalStore` snapshot, not a React Query fetcher.
    if (!parsed.success) return cachedPrice;

    // Null when every upstream source is down. There is no quote to publish,
    // and zero is not one.
    if (parsed.data.price === null) return cachedPrice;

    // `updatedAt` is when the quote was observed, not when it was fetched, so a
    // cached upstream response keeps its original stamp. An absent or
    // unparseable one falls back to now.
    const observedAt = parsed.data.updatedAt
      ? new Date(parsed.data.updatedAt).getTime()
      : Number.NaN;

    const next: PriceData = {
      usd: parsed.data.price,
      change24h: parsed.data.change24h,
      timestamp: Number.isFinite(observedAt) ? observedAt : Date.now(),
    };

    // Keep the previous object when nothing moved. `getCachedPrice` is a
    // `useSyncExternalStore` snapshot, so a fresh identity every minute would
    // re-render every subscriber on an unchanged price. `timestamp` is excluded
    // deliberately: it advances on each poll even when the quote does not.
    const moved =
      cachedPrice === null ||
      cachedPrice.usd !== next.usd ||
      cachedPrice.change24h !== next.change24h;
    if (!moved) return cachedPrice;

    cachedPrice = next;
    for (const listener of listeners) listener();

    return cachedPrice;
  } catch {
    // Network error — return cached value
    return cachedPrice;
  }
}

/**
 * Returns the most recently cached price, or null if none has been fetched yet.
 */
export function getCachedPrice(): PriceData | null {
  return cachedPrice;
}

/**
 * Keep the price fresh while at least one consumer needs it.
 *
 * Polling used to be single-owner: `startPricePolling(cb)` installed one timer
 * and one callback, and `stopPricePolling()` tore it down. The home screen
 * owned it through a focus effect, so leaving that tab stopped polling for the
 * whole app — every other screen showing a price, and every `subscribeToPrice`
 * subscriber, silently froze at the last value fetched while home was focused.
 *
 * Reference counting removes the owner: whoever needs a price acquires, and the
 * timer runs while anyone holds it. Updates reach consumers through the
 * subscription rather than a per-caller callback.
 *
 * @returns a release function; call it on unmount.
 */
export function acquirePricePolling(): () => void {
  subscriberCount += 1;
  if (pollTimer === null) {
    // Poll immediately on the first acquire so a cold screen is not blank for
    // a whole interval.
    void fetchPrice();
    pollTimer = setInterval(() => {
      void fetchPrice();
    }, PRICE_POLL_INTERVAL);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount -= 1;
    if (subscriberCount <= 0 && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
      subscriberCount = 0;
    }
  };
}
