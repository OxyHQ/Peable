import {
  safeFetch as realSafeFetch,
  SsrfRejection,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  UpstreamError,
  type ServiceHttpClient,
} from '@oxy.so/core/server';
import { signWebhook, type WebhookEvent } from '@peable.to/shared-types';
import { oxy } from '../oxy';

/** The concrete `safeFetch` signature — injected in tests, real one in prod. */
export type SafeFetchFn = typeof import('@oxy.so/core/server').safeFetch;

/** Oxy's own transport (`createServiceClient().fetch`) — injected in tests. */
export type FirstPartyFetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Header every delivery is signed in. */
export const WEBHOOK_SIGNATURE_HEADER = 'Peable-Signature';

/**
 * Where one delivery is POSTed, and every secret that signs it: the endpoint's
 * current secret first, then a rolled one still inside its overlap window.
 */
export interface WebhookTarget {
  url: string;
  secrets: readonly string[];
  /** The endpoint's merchant is a VERIFIED first-party merchant (`merchants.first_party`). */
  firstParty: boolean;
}

const MILLIS_PER_SECOND = 1000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 300;
const HTTP_SERVER_ERROR_MIN = 500;

/** One attempt's conclusion, in the outbox's vocabulary. */
export type AttemptOutcome =
  | { kind: 'delivered' }
  | { kind: 'refused'; reason: string }
  | { kind: 'retry'; reason: string };

/**
 * How a delivery leaves Peable — the ONE place that decides it (ADR 0014 D4).
 *
 * - `first_party`: Oxy's own API, reached through the shared `OxyServer`
 *   (`createServiceClient().fetch`, Peable's workload authority). Inside the
 *   VPC `api.oxy.so` resolves to a private address, which `safeFetch` refuses
 *   by design, so this is the only way Oxy receives its own events.
 * - `public`: every other URL, through `safeFetch` and all of its SSRF checks.
 *
 * Both halves are required. Whether the URL is Oxy's own API is the SDK's
 * answer (`oxy.isFirstPartyServiceUrl`: exactly the configured API origin), never
 * a hostname list or suffix match here. And the merchant must be VERIFIED
 * first-party, because this lane carries Peable's own bearer: a third-party
 * merchant naming `api.oxy.so` must not be able to aim Peable's authority at
 * an Oxy route, so its URL stays on `safeFetch` (and is refused there).
 */
export function webhookDeliveryLane(target: WebhookTarget): 'first_party' | 'public' {
  return target.firstParty && oxy.isFirstPartyServiceUrl(target.url) ? 'first_party' : 'public';
}

let firstPartyClient: ServiceHttpClient | null = null;
/** Oxy's transport, made once per process: it caches the workload token. */
const oxyFetch: FirstPartyFetchFn = (url, init) => {
  firstPartyClient ??= oxy.createServiceClient({ baseURL: oxy.baseURL, audience: 'oxy-api' });
  return firstPartyClient.fetch(url, init);
};

interface SignedPost {
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** POST through `safeFetch`; the status, or a thrown `SsrfRejection` / `UpstreamError`. */
async function postPublic(url: string, post: SignedPost, safeFetch: SafeFetchFn): Promise<number> {
  const result = await safeFetch(url, { method: 'POST', headers: post.headers, body: post.body });
  // We do not read the body; the caller of `safeFetch` owns the stream.
  result.response.destroy();
  return result.status;
}

/**
 * POST through Oxy's own transport. Same bytes, same headers, same deadline to
 * the response headers as `safeFetch`; the transport refuses redirects. Every
 * failure to get a status (timeout, network, a redirect, the token mint) is an
 * `UpstreamError`, so it is classified exactly as `safeFetch`'s are: retried.
 */
async function postFirstParty(
  url: string,
  post: SignedPost,
  firstPartyFetch: FirstPartyFetchFn,
): Promise<number> {
  let response: Response;
  try {
    response = await firstPartyFetch(url, {
      method: 'POST',
      headers: post.headers,
      body: post.body,
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_HEADERS_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UpstreamError(
      `first-party transport: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}

/**
 * Make ONE signed POST to a merchant endpoint and classify what came back.
 *
 * One attempt, not a loop. The retry schedule belongs to the outbox — a
 * function that slept through its own backoff could only ever retry for as long
 * as one request handler was willing to wait, which is what made the old
 * three-attempts-in-150ms delivery lose events to a merchant restart.
 *
 * The body and signature are made once, before the lane is chosen, so both
 * lanes send the same bytes; the classification below is shared by both.
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
 * The URL itself was already judged by `webhookUrlProblem` (the outbox, before
 * this is called): this is the transport, not the registration rule.
 */
export async function attemptDelivery(
  event: WebhookEvent,
  target: WebhookTarget,
  deps: { safeFetch?: SafeFetchFn; firstPartyFetch?: FirstPartyFetchFn } = {},
): Promise<AttemptOutcome> {
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / MILLIS_PER_SECOND);
  const post: SignedPost = {
    headers: {
      'Content-Type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: signWebhook(target.secrets, rawBody, timestamp),
    },
    body: rawBody,
  };

  try {
    const status =
      webhookDeliveryLane(target) === 'first_party'
        ? await postFirstParty(target.url, post, deps.firstPartyFetch ?? oxyFetch)
        : await postPublic(target.url, post, deps.safeFetch ?? realSafeFetch);
    if (status >= HTTP_OK_MIN && status < HTTP_OK_MAX) {
      return { kind: 'delivered' };
    }
    if (status < HTTP_SERVER_ERROR_MIN) {
      return { kind: 'refused', reason: `target responded ${status}` };
    }
    return { kind: 'retry', reason: `target responded ${status}` };
  } catch (error) {
    if (error instanceof SsrfRejection) {
      // Warned, not just recorded: an SSRF-rejected target is a configuration
      // an operator should see, and the row's `last_error` is only read by
      // somebody already looking at that merchant.
      process.emitWarning(
        `Peable webhook target refused as SSRF-unsafe: ${target.url} (${error.message})`,
      );
      return { kind: 'refused', reason: `ssrf rejection: ${error.message}` };
    }
    if (error instanceof UpstreamError) {
      return { kind: 'retry', reason: `upstream error: ${error.message}` };
    }
    // An unexpected failure. `retry` rather than `refused`, deliberately:
    // assuming an unknown defect is permanent is how a recoverable outage
    // becomes an abandoned event, and the attempt budget bounds the cost of
    // being wrong in this direction.
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'retry', reason: `unexpected error: ${message}` };
  }
}
