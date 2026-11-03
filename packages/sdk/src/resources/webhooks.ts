import { verifyWebhook, type WebhookEvent, type WebhookEventType } from '@peable.to/shared-types';
import { PeableSignatureVerificationError } from '../core/errors';

/** The header every delivery is signed in. */
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
  'payment_intent.created': true,
  'payment_intent.requires_action': true,
  'payment_intent.processing': true,
  'payment_intent.amount_capturable_updated': true,
  'payment_intent.succeeded': true,
  'payment_intent.payment_failed': true,
  'payment_intent.canceled': true,
  'charge.refunded': true,
  'charge.dispute.created': true,
  'charge.dispute.updated': true,
  'charge.dispute.closed': true,
  'charge.dispute.funds_withdrawn': true,
  'charge.dispute.funds_reinstated': true,
  'refund.created': true,
  'refund.updated': true,
  'refund.failed': true,
  'customer.created': true,
  'customer.updated': true,
  'customer.deleted': true,
  'payment_method.attached': true,
  'payment_method.detached': true,
  'payment_method.updated': true,
  'setup_intent.created': true,
  'setup_intent.requires_action': true,
  'setup_intent.succeeded': true,
  'setup_intent.setup_failed': true,
  'setup_intent.canceled': true,
  'product.created': true,
  'product.updated': true,
  'product.deleted': true,
  'price.created': true,
  'price.updated': true,
  'coupon.created': true,
  'coupon.updated': true,
  'coupon.deleted': true,
  'promotion_code.created': true,
  'promotion_code.updated': true,
  'billing.observation.updated': true,
  'connected_account.updated': true,
  'account.updated': true,
  'application_fee.created': true,
  'application_fee.refunded': true,
  'payout.created': true,
  'payout.updated': true,
  'payout.paid': true,
  'payout.failed': true,
  'payout.canceled': true,
  'balance.available': true,
  'webhook_endpoint.test': true,
} satisfies Record<WebhookEventType, true>;

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/**
 * Structural guard for the parsed payload — the signature already proves the
 * bytes were produced by `signWebhook` on the SAME secret, but a caller could
 * still pass an unrelated (validly HMAC'd under a shared secret) JSON blob;
 * this keeps `constructEvent`'s return type honest rather than a blind cast.
 */
function isWebhookEventShape(value: unknown): value is WebhookEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WebhookEvent>;
  const valid =
    typeof candidate.id === 'string' &&
    candidate.object === 'event' &&
    typeof candidate.livemode === 'boolean' &&
    typeof candidate.type === 'string' &&
    // biome-ignore lint/suspicious/noPrototypeBuiltins: the published SDK targets ES2020, and Object.hasOwn is ES2022
    Object.prototype.hasOwnProperty.call(WEBHOOK_EVENT_TYPES, candidate.type) &&
    Number.isSafeInteger(candidate.created) &&
    typeof candidate.api_version === 'string' &&
    typeof candidate.request === 'object' &&
    candidate.request !== null &&
    isNullableString(candidate.request.id) &&
    isNullableString(candidate.request.idempotency_key) &&
    typeof candidate.data === 'object' &&
    candidate.data !== null &&
    'object' in candidate.data;
  if (!valid) return false;
  if (candidate.type === 'billing.observation.updated') {
    const data = candidate.data?.object;
    if (!data || typeof data !== 'object') return false;
    const v = data as unknown as Record<string, unknown>;
    return (
      v.object === 'billing_observation' &&
      v.livemode === candidate.livemode &&
      (v.resource_kind === 'subscription' || v.resource_kind === 'invoice') &&
      typeof v.resource_id === 'string' &&
      v.resource_id.length > 0 &&
      (v.subscription_id === undefined ||
        (typeof v.subscription_id === 'string' &&
          /^[A-Za-z0-9_.:-]{1,128}$/.test(v.subscription_id))) &&
      typeof v.revision === 'number' &&
      Number.isSafeInteger(v.revision) &&
      v.revision > 0 &&
      Number.isSafeInteger(v.observed_at) &&
      Object.keys(v).every((k) =>
        [
          'object',
          'livemode',
          'resource_kind',
          'resource_id',
          'subscription_id',
          'revision',
          'observed_at',
        ].includes(k),
      )
    );
  }
  return true;
}

export class WebhooksResource {
  /**
   * Verify a webhook delivery and parse it into a typed `WebhookEvent`.
   * Verifies via the SAME `verifyWebhook` the Gateway signs with
   * (`@peable.to/shared-types`) so the algorithm can never drift between the two
   * sides. Throws `PeableSignatureVerificationError` on a bad/stale/tampered
   * signature or a malformed payload — never returns a partially-trusted
   * event.
   *
   * `endpointSecret` is the endpoint's `whsec_…` — or several, while you are
   * rotating: the event is accepted when ANY `v1=` signature in the header
   * matches ANY of them. During a `roll_secret` overlap Peable signs every
   * delivery with both the new and the previous secret, so either side of
   * your switch verifies it.
   */
  constructEvent(
    rawBody: string,
    signatureHeader: string,
    endpointSecret: string | readonly string[],
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
