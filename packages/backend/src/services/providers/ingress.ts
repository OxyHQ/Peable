/**
 * The trust boundary: an untrusted delivery becomes a stored, verified event.
 *
 * **Receipt is separate from processing.** This verifies, redacts, writes one
 * row and returns. What the event MEANS is worked out afterwards, by a drain
 * the provider is not waiting on. Processing inside the request would make
 * every downstream failure look to the provider like a delivery failure — so it
 * retries, so the work happens twice, and the only defence left is whatever
 * idempotency the handler happens to have.
 *
 * **This function never throws.** Every outcome is a value, because the caller
 * is an HTTP handler whose status code is a message to the provider: a 500 asks
 * for a retry, and asking for a retry of a forged signature or a test event on
 * a live deployment is exactly wrong.
 *
 * Ported in shape from Mercaria's `services/payments/stripe/ingress.ts`.
 */

import { getDb } from '../../db/postgres';
import { insertProviderEvent } from '../../db/providers/providerEventRepository';
import { config } from '../../config';
import { ProviderError, type ProviderEventEnvelope, type ProviderId } from './provider';
import { resolveProvider } from './registry';
import type { StripeWebhookScope } from './stripe/stripeProvider';
import { StripePaymentProvider } from './stripe/stripeProvider';
import { redactProviderPayload } from './redact';

export interface ProviderDelivery {
  /** The RAW body. A signature covers bytes, not a re-serialization. */
  readonly payload: Buffer;
  readonly signature: string;
  readonly scope: StripeWebhookScope;
}

export type IngressResult =
  /** Verified, stored, and waiting to be processed. */
  | { readonly kind: 'accepted'; readonly eventId: string }
  /** Verified, and we already had it. A provider retry, answered the same way. */
  | { readonly kind: 'duplicate' }
  /** Verified and deliberately not stored — see `ignored` below. */
  | { readonly kind: 'ignored'; readonly reason: 'livemode_mismatch' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalid_signature' | 'not_configured';
      readonly detail: string;
    };

/**
 * Ingest one delivery.
 *
 * A `duplicate` answers 2xx exactly like an `accepted` one: the provider has
 * done its job and telling it otherwise would make it retry forever. An
 * `ignored` event is 2xx too — a test event reaching a live endpoint is a
 * misconfiguration to fix in the dashboard, not a delivery to retry.
 */
export async function ingestProviderDelivery(
  delivery: ProviderDelivery,
  provider: ProviderId = 'stripe',
): Promise<IngressResult> {
  const adapter = resolveProvider(provider);
  if (!adapter) {
    return {
      kind: 'rejected',
      reason: 'not_configured',
      detail: `the ${provider} rail is not configured on this deployment`,
    };
  }

  let envelope: ProviderEventEnvelope;
  try {
    // The scope decides WHICH secrets are tried. Accepting either endpoint's
    // secret on either endpoint would mean a leaked platform secret could forge
    // a connected-account event.
    envelope =
      adapter instanceof StripePaymentProvider
        ? await adapter.verifyEventForScope(
            { payload: delivery.payload.toString('utf8'), signature: delivery.signature },
            delivery.scope,
          )
        : await adapter.verifyEvent({
            payload: delivery.payload.toString('utf8'),
            signature: delivery.signature,
          });
  } catch (error) {
    return {
      kind: 'rejected',
      reason: 'invalid_signature',
      detail: error instanceof ProviderError ? error.message : 'signature verification failed',
    };
  }

  // A production URL receives test events too — an operator clicking "send test
  // webhook" produces one. Processing it on a live deployment would settle a
  // payment that does not exist.
  if (envelope.livemode !== config.stripe.livemode) {
    return { kind: 'ignored', reason: 'livemode_mismatch' };
  }

  const stored = await insertProviderEvent(getDb(), {
    provider: envelope.provider,
    providerEventId: envelope.providerEventId,
    providerAccountId: envelope.providerAccountId ?? null,
    type: envelope.type,
    livemode: envelope.livemode,
    apiVersion: envelope.apiVersion ?? null,
    objectIds: envelope.objectIds,
    // REDACTED before it is stored, never after. This table is where a support
    // query looks, and a raw provider payload carries payer names, addresses
    // and card fingerprints.
    payload: redactProviderPayload(envelope.payload),
  });

  // `null` means the unique index converged: the provider retried a delivery we
  // already have. That is a success, not a conflict.
  return stored === null ? { kind: 'duplicate' } : { kind: 'accepted', eventId: stored };
}
