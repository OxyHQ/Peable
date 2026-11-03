import { randomBytes } from 'node:crypto';
import { WEBHOOK_SIGNATURE_HEADER } from '@peable.to/sdk';
import { signWebhook } from '@peable.to/shared-types';
import { USER_AGENT } from './version.js';

/**
 * `peable listen`'s half of a webhook: sign an event the way the gateway signs
 * a delivery, and POST it to the developer's local server.
 *
 * The signature is the gateway's own algorithm (`signWebhook` from
 * `@peable.to/shared-types`, the function the dispatcher calls), under a
 * secret this session generated — so a receiver's
 * `peable.webhooks.constructEvent(rawBody, header, secret)` verifies a
 * forwarded event exactly as it will verify a real delivery, once it is
 * configured with the endpoint's secret instead.
 *
 * The body is the event as the stream rendered it, which is the object a
 * delivery carries (ADR 0014 D4), serialized the way the dispatcher
 * serializes it.
 */

/** A per-session signing secret, in the shape the gateway generates: `whsec_` + 64 hex. */
export function generateSessionSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

/** The exact bytes and header a delivery of `event` carries, signed now with `secret`. */
export function signForDelivery(
  event: unknown,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { body: string; signature: string } {
  const body = JSON.stringify(event);
  return { body, signature: signWebhook(secret, body, nowSeconds) };
}

export type ForwardResult =
  | { readonly ok: true; readonly status: number; readonly durationMs: number }
  | { readonly ok: false; readonly error: string };

/** How long a local server has to answer, as the gateway gives an endpoint. */
export const FORWARD_TIMEOUT_MS = 30_000;

/**
 * POST one event to `url`, signed. Never throws: a refused connection or a
 * timeout is a result to print, and the next event is still forwarded.
 */
export async function forwardEvent(
  event: unknown,
  options: {
    readonly url: string;
    readonly secret: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof fetch;
  },
): Promise<ForwardResult> {
  const { body, signature } = signForDelivery(event, options.secret);
  const started = performance.now();
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        [WEBHOOK_SIGNATURE_HEADER]: signature,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? FORWARD_TIMEOUT_MS),
    });
    // The body is not read: like the gateway, only the status matters.
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: true,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.name === 'TimeoutError'
          ? `no answer within ${String(options.timeoutMs ?? FORWARD_TIMEOUT_MS)}ms`
          : (error.cause instanceof Error ? error.cause.message : '') || error.message
        : String(error);
    return { ok: false, error: reason };
  }
}
