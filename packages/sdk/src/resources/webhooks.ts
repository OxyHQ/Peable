import { verifyWebhook, type WebhookEvent, type WebhookEventType } from '@peable.to/shared-types';
import { PeableSignatureVerificationError } from '../core/errors';

/** Header the Gateway's `webhookDispatcher.deliver` signs with (`Peable-Signature`). */
export const WEBHOOK_SIGNATURE_HEADER = 'Peable-Signature';

/** Default replay-tolerance window, matching the backend's own tests/usage. */
const DEFAULT_TOLERANCE_SEC = 300;

export interface ConstructEventOptions {
  /** Max allowed drift (seconds) between the signed timestamp and now. */
  toleranceSec?: number;
}

// Exhaustive against the published union: adding a backend event makes this
// fail compilation until the SDK accepts it. Own-key lookup excludes prototype
// names supplied by an untrusted, even correctly signed, payload.
const WEBHOOK_EVENT_TYPES = {
  'payment_intent.confirming': true,
  'payment_intent.settled': true,
  'payment_intent.failed': true,
  'payment_intent.rejected': true,
  'payment_intent.expired': true,
  'payment_intent.refunded': true,
  'payment_intent.partially_refunded': true,
  'payment_intent.disputed': true,
  'payment_intent.dispute_closed': true,
  'connected_account.updated': true,
} satisfies Record<WebhookEventType, true>;

/**
 * Structural guard for the parsed payload — the signature already proves the
 * bytes were produced by `signWebhook` on the SAME secret, but a caller could
 * still pass an unrelated (validly HMAC'd under a shared secret) JSON blob;
 * this keeps `constructEvent`'s return type honest rather than a blind cast.
 */
function isWebhookEventShape(value: unknown): value is WebhookEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WebhookEvent>;
  return (
    typeof candidate.id === 'string' &&
    candidate.object === 'event' &&
    typeof candidate.type === 'string' &&
    Object.prototype.hasOwnProperty.call(WEBHOOK_EVENT_TYPES, candidate.type) &&
    typeof candidate.created === 'string' &&
    typeof candidate.data === 'object' &&
    candidate.data !== null &&
    'object' in candidate.data
  );
}

export class WebhooksResource {
  /**
   * Verify a webhook delivery and parse it into a typed `WebhookEvent`.
   * Verifies via the SAME `verifyWebhook` the Gateway signs with
   * (`@peable.to/shared-types`) so the algorithm can never drift between the two
   * sides. Throws `PeableSignatureVerificationError` on a bad/stale/tampered
   * signature or a malformed payload — never returns a partially-trusted
   * event.
   */
  constructEvent(
    rawBody: string,
    signatureHeader: string,
    endpointSecret: string,
    opts: ConstructEventOptions = {},
  ): WebhookEvent {
    const toleranceSec = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
    const nowSec = Math.floor(Date.now() / 1000);

    const verified = verifyWebhook(endpointSecret, rawBody, signatureHeader, toleranceSec, nowSec);
    if (!verified) {
      throw new PeableSignatureVerificationError(
        'Webhook signature verification failed — the payload, signature header, or secret do not match, or the timestamp is stale.',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new PeableSignatureVerificationError(
        'Webhook signature verified, but the payload is not valid JSON',
      );
    }

    if (!isWebhookEventShape(parsed)) {
      throw new PeableSignatureVerificationError(
        'Webhook signature verified, but the payload does not match the expected event shape',
      );
    }

    return parsed;
  }
}
