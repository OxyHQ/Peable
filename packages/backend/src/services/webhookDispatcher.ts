import {
  safeFetch as realSafeFetch,
  SsrfRejection,
  UpstreamError,
  type SafeFetchResult,
} from "@oxyhq/core/server";
import {
  signWebhook,
  type PaymentIntent,
  type WebhookEvent,
  type WebhookEventPayload,
  type WebhookEventType,
} from "@peable.to/shared-types";
import { newId } from "../lib/ids";

/** The concrete `safeFetch` signature — injected in tests, real one in prod. */
export type SafeFetchFn = typeof import("@oxyhq/core/server").safeFetch;

/** Where a merchant's signed webhook events are POSTed, and the signing secret. */
export interface WebhookTarget {
  url: string;
  secret: string;
}

const MILLIS_PER_SECOND = 1000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;
const HTTP_SERVER_ERROR_MIN = 500;

/**
 * Wrap a resource in a Stripe-parity `evt_` webhook envelope. `created` is the
 * emission time in ISO-8601; the resource sits under `data.object`.
 *
 * GENERIC over the event type, so `WebhookEventPayload` decides which resource
 * each one may carry. It used to take a `PaymentIntent` for every type, which
 * was true until the two dispute events arrived and would then have shipped a
 * settlement's payload under `payment_intent.disputed` — the compiler now
 * refuses that pairing at the one place events are built.
 */
export function buildEvent<K extends WebhookEventType>(
  type: K,
  object: WebhookEventPayload[K],
): WebhookEvent<K> {
  return {
    id: newId("evt"),
    object: "event",
    type,
    created: new Date(Date.now()).toISOString(),
    data: { object },
  };
}

/** One attempt's conclusion, in the outbox's vocabulary. */
export type AttemptOutcome =
  | { kind: "delivered" }
  | { kind: "refused"; reason: string }
  | { kind: "retry"; reason: string };

/**
 * Make ONE signed POST to a merchant endpoint and classify what came back.
 *
 * One attempt, not a loop. The retry schedule belongs to the outbox — a
 * function that slept through its own backoff could only ever retry for as long
 * as one request handler was willing to wait, which is what made the old
 * three-attempts-in-150ms delivery lose events to a merchant restart.
 *
 * Never throws. Every failure is classified, because the caller has to write an
 * outcome to a row either way, and an exception here would leave that row
 * leased and unrecorded until its lease expired.
 *
 * - 2xx → `delivered`.
 * - 5xx, timeout, redirect (`UpstreamError`) → `retry`; the endpoint is having
 *   a bad moment.
 * - any other non-2xx (4xx) → `refused`; the target rejected the payload and no
 *   number of retries turns that into an acceptance.
 * - `SsrfRejection` → `refused`; the URL resolves to a blocked address, and
 *   retrying cannot make a blocked target safe.
 *
 * The caller owns the `safeFetch` response stream — we do not read the body, so
 * every attempt destroys it in `finally`.
 */
export async function attemptDelivery(
  event: WebhookEvent | Record<string, unknown>,
  target: WebhookTarget,
  deps: { safeFetch?: SafeFetchFn } = {},
): Promise<AttemptOutcome> {
  const safeFetch = deps.safeFetch ?? realSafeFetch;
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / MILLIS_PER_SECOND);
  const signature = signWebhook(target.secret, rawBody, timestamp);

  let result: SafeFetchResult | null = null;
  try {
    result = await safeFetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Peable-Signature": signature,
      },
      body: rawBody,
    });
    if (result.status >= HTTP_OK_MIN && result.status < HTTP_OK_MAX) {
      return { kind: "delivered" };
    }
    if (result.status < HTTP_SERVER_ERROR_MIN) {
      return { kind: "refused", reason: `target responded ${result.status}` };
    }
    return { kind: "retry", reason: `target responded ${result.status}` };
  } catch (error) {
    if (error instanceof SsrfRejection) {
      // Warned, not just recorded: an SSRF-rejected target is a configuration
      // an operator should see, and the row's `last_error` is only read by
      // somebody already looking at that merchant.
      process.emitWarning(
        `Peable webhook target refused as SSRF-unsafe: ${target.url} (${error.message})`,
      );
      return { kind: "refused", reason: `ssrf rejection: ${error.message}` };
    }
    if (error instanceof UpstreamError) {
      return { kind: "retry", reason: `upstream error: ${error.message}` };
    }
    // An unexpected failure. `retry` rather than `refused`, deliberately:
    // assuming an unknown defect is permanent is how a recoverable outage
    // becomes an abandoned event, and the attempt budget bounds the cost of
    // being wrong in this direction.
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "retry", reason: `unexpected error: ${message}` };
  } finally {
    result?.response.destroy();
  }
}
