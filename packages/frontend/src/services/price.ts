/**
 * Price service for FairCoin wallet.
 * Polls the Explorer API for current price data and caches it locally.
 */

import { EXPLORER_BASE_URL } from "@fairco.in/core";

const EXPLORER_API = EXPLORER_BASE_URL;
const PRICE_POLL_INTERVAL = 60_000; // 1 minute

export interface PriceData {
  usd: number;
  eur: number;
  btc: number;
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

    const data = (await response.json()) as {
      price?: { usd: number; eur: number; btc: number } | null;
      change_24h?: { usd: number } | null;
      timestamp?: string;
    };

    if (!data.price) return cachedPrice;

    const next: PriceData = {
      usd: data.price.usd,
      eur: data.price.eur,
      btc: data.price.btc,
      change24h: data.change_24h?.usd ?? null,
      timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
    };

    // Keep the previous object when nothing moved. `getCachedPrice` is a
    // `useSyncExternalStore` snapshot, so a fresh identity every minute would
    // re-render every subscriber on an unchanged price. `timestamp` is excluded
    // deliberately: it advances on each poll even when the quote does not.
    const moved =
      cachedPrice === null ||
      cachedPrice.usd !== next.usd ||
      cachedPrice.eur !== next.eur ||
      cachedPrice.btc !== next.btc ||
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
