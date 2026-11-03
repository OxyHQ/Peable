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
 * for a retry, and asking for a retry of a forged signature is exactly wrong.
 *
 * Ported in shape from Mercaria's `services/payments/stripe/ingress.ts`.
 */

import { getDb } from '../../db/postgres';
import { insertProviderEvent } from '../../db/providers/providerEventRepository';
import {
  ProviderError,
  providerModeOf,
  type PaymentProvider,
  type ProviderEventEnvelope,
  type ProviderId,
  type ProviderMode,
} from './provider';
import { availableProviderModes, resolveProvider } from './registry';
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
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalid_signature' | 'not_configured';
      readonly detail: string;
    };

/** Verify one delivery against ONE mode's adapter — that mode's endpoint secrets and nothing else. */
async function verifyIn(
  adapter: PaymentProvider,
  delivery: ProviderDelivery,
): Promise<ProviderEventEnvelope> {
  const input = { payload: delivery.payload.toString('utf8'), signature: delivery.signature };
  // The scope decides WHICH secrets are tried. Accepting either endpoint's
  // secret on either endpoint would mean a leaked platform secret could forge
  // a connected-account event.
  return adapter instanceof StripePaymentProvider
    ? adapter.verifyEventForScope(input, delivery.scope)
    : adapter.verifyEvent(input);
}

/**
 * Ingest one delivery.
 *
 * ## Which mode an event belongs to (ADR 0017)
 *
 * Test and live deliveries arrive on the SAME two paths, signed by different
 * endpoints with different secrets — Stripe keeps a test-mode endpoint and a
 * live-mode endpoint even when both point at one URL. So the delivery is
 * verified against each configured mode's secrets in turn, and the mode whose
 * secret verifies it is the mode it came from. Nothing in the body is trusted
 * to choose the secret.
 *
 * The event's own `livemode` must then AGREE with that mode, or it is refused.
 * Stripe never signs a live event with a test endpoint's secret, so a
 * disagreement means somebody holding one mode's secret signed a body claiming
 * to be the other — a leaked test secret must not be able to settle a live
 * payment. The stored `provider_events.livemode` is therefore a fact about the
 * key that verified it, and the drain routes processing by it.
 *
 * An event of a mode this deployment has no key for cannot verify against any
 * secret and is refused like any other bad signature: 400, nothing stored.
 *
 * A `duplicate` answers 2xx exactly like an `accepted` one: the provider has
 * done its job and telling it otherwise would make it retry forever.
 */
export async function ingestProviderDelivery(
  delivery: ProviderDelivery,
  provider: ProviderId = 'stripe',
): Promise<IngressResult> {
  const modes = availableProviderModes(provider);
  if (modes.length === 0) {
    return {
      kind: 'rejected',
      reason: 'not_configured',
      detail: `the ${provider} rail is not configured on this deployment`,
    };
  }

  let envelope: ProviderEventEnvelope | undefined;
  let verifiedMode: ProviderMode | undefined;
  let lastDetail = 'signature verification failed';
  for (const mode of modes) {
    const adapter = resolveProvider(provider, mode);
    if (!adapter) continue;
    try {
      envelope = await verifyIn(adapter, delivery);
      verifiedMode = mode;
      break;
    } catch (error) {
      if (error instanceof ProviderError) lastDetail = error.message;
    }
  }
  if (envelope === undefined || verifiedMode === undefined) {
    return { kind: 'rejected', reason: 'invalid_signature', detail: lastDetail };
  }

  if (providerModeOf(envelope.livemode) !== verifiedMode) {
    return {
      kind: 'rejected',
      reason: 'invalid_signature',
      detail: `a ${envelope.livemode ? 'live' : 'test'} event signed with the ${verifiedMode} endpoint secret`,
    };
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
