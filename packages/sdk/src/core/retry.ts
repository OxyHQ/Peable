// When a failed attempt is tried again, and after how long.
//
// Retried: a request that got no answer (network failure, timeout, a body cut
// off mid-read), a 5xx, a 429, and a 409 `idempotency_error` — the first
// attempt under that key is still running, so the next one replays its stored
// answer. Never retried: any other 4xx, which says the REQUEST is wrong and
// will be wrong again. A `POST` is safe to try again because every attempt
// carries the same `Idempotency-Key` (ADR 0014 D3): the gateway runs it once
// and answers every later attempt with the stored response.

import { PeableConnectionError, type PeableError } from './errors';

/** The first backoff; each retry doubles it. */
export const INITIAL_RETRY_DELAY_MS = 500;
/** The longest computed backoff. */
export const MAX_RETRY_DELAY_MS = 8_000;
/** The longest `Retry-After` honoured; a longer one is waited this long. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Whether an attempt that ended in `error` may be tried again. */
export function isRetryable(error: PeableError): boolean {
  if (error instanceof PeableConnectionError) return true;
  const status = error.statusCode;
  if (status === undefined) return false;
  if (status === 409) return error.type === 'idempotency_error';
  return status === 429 || status >= 500;
}

/**
 * `Retry-After` in milliseconds: delta-seconds or an HTTP date. `undefined`
 * when absent or unreadable.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * The wait before retry number `retry` (0 for the first): exponential from
 * {@link INITIAL_RETRY_DELAY_MS}, capped at {@link MAX_RETRY_DELAY_MS}, with
 * jitter in its upper half so a fleet of clients does not retry in step — and
 * never shorter than the gateway's `Retry-After` (itself capped).
 */
export function retryDelayMs(
  retry: number,
  retryAfter: number | undefined,
  random = Math.random(),
): number {
  const exponential = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** retry, MAX_RETRY_DELAY_MS);
  const jittered = Math.round(exponential * (0.5 + random * 0.5));
  if (retryAfter === undefined) return jittered;
  return Math.max(jittered, Math.min(retryAfter, MAX_RETRY_AFTER_MS));
}

/** Resolve after `ms`, or as soon as `signal` aborts (then rejecting with its reason). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
