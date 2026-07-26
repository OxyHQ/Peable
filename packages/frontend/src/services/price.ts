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

    cachedPrice = {
      usd: data.price.usd,
      eur: data.price.eur,
      btc: data.price.btc,
      change24h: data.change_24h?.usd ?? null,
      timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
    };

    // A new object identity, so `getCachedPrice` stays a valid snapshot: it
    // returns the same reference until the price actually changes.
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
 * Start polling the Explorer API for price updates.
 * Calls `onUpdate` whenever a new price is successfully fetched.
 */
export function startPricePolling(onUpdate: (price: PriceData) => void): void {
  stopPricePolling();

  const poll = async () => {
    const price = await fetchPrice();
    if (price) {
      onUpdate(price);
    }
  };

  // Immediate first poll
  poll();
  pollTimer = setInterval(poll, PRICE_POLL_INTERVAL);
}

/**
 * Stop the price polling interval.
 */
export function stopPricePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
