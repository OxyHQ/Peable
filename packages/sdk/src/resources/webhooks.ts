import { verifyWebhook, type WebhookEvent, type WebhookEventType } from '@peable.to/shared-types';
import { PeableSignatureVerificationError } from '../core/errors';

/** The header every delivery is signed in. */
export const WEBHOOK_SIGNATURE_HEADER = 'Peable-Signature';

/** The default replay window: how far (seconds) the signed timestamp may be from now. */
export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;

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
  'checkout.session.completed': true,
  'checkout.session.expired': true,
  'checkout.session.async_payment_succeeded': true,
  'checkout.session.async_payment_failed': true,
  'payment_link.created': true,
  'payment_link.updated': true,
  'customer.subscription.created': true,
  'customer.subscription.updated': true,
  'customer.subscription.deleted': true,
  'customer.subscription.trial_will_end': true,
  'customer.subscription.paused': true,
  'customer.subscription.resumed': true,
  'invoice.created': true,
  'invoice.updated': true,
  'invoice.deleted': true,
  'invoice.finalized': true,
  'invoice.paid': true,
  'invoice.payment_failed': true,
  'invoice.payment_action_required': true,
  'invoice.voided': true,
  'invoice.marked_uncollectible': true,
  'invoice.upcoming': true,
  'invoice.sent': true,
  'invoiceitem.created': true,
  'invoiceitem.deleted': true,
  'credit_note.created': true,
  'credit_note.updated': true,
  'credit_note.voided': true,
  'test_helpers.test_clock.created': true,
  'test_helpers.test_clock.advancing': true,
  'test_helpers.test_clock.ready': true,
  'test_helpers.test_clock.deleted': true,
  'billing.meter.created': true,
  'billing.meter.updated': true,
  'billing.meter.deactivated': true,
  'billing.meter.reactivated': true,
  'entitlements.active_entitlement_summary.updated': true,
  'billing_portal.configuration.created': true,
  'billing_portal.configuration.updated': true,
  'billing_portal.session.created': true,
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
  'reporting.report_run.succeeded': true,
  'reporting.report_run.failed': true,
  'tax.assessment.created': true,
  'tax.review_item.created': true,
  'tax.review_item.updated': true,
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
  return (
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
    'object' in candidate.data
  );
}

export class WebhooksResource {
  /**
   * Verify a webhook delivery and parse it into a typed `WebhookEvent`.
   *
   * `payload` is the RAW request body — the exact bytes Peable signed (a
   * `Buffer` or `Uint8Array`, or that body decoded as UTF-8); a body parsed
   * and re-serialized will not verify. `signatureHeader` is the
   * `Peable-Signature` header. `secret` is the endpoint's `whsec_…` — or
   * several, while you rotate: the event is accepted when ANY `v1=` signature
   * in the header matches ANY of them, and during a `roll_secret` overlap
   * Peable signs every delivery with both the new and the previous secret.
   * `tolerance` is the replay window in seconds (default 300).
   *
   * Verifies with the SAME `verifyWebhook` the gateway signs with
   * (`@peable.to/shared-types`, timing-safe), so the two sides cannot drift.
   * Throws `PeableSignatureVerificationError` on a bad, stale or tampered
   * signature or a malformed payload — never returns a partially trusted event.
   */
  constructEvent(
    payload: string | Uint8Array,
    signatureHeader: string,
    secret: string | readonly string[],
    tolerance: number = DEFAULT_WEBHOOK_TOLERANCE_SEC,
  ): WebhookEvent {
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      throw new TypeError('Peable: the webhook tolerance is a non-negative number of seconds');
    }
    const rawBody = typeof payload === 'string' ? payload : decodeExactUtf8(payload);
    const nowSec = Math.floor(Date.now() / 1000);

    const verified = verifyWebhook(secret, rawBody, signatureHeader, tolerance, nowSec);
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

/**
 * The exact text a byte payload signs, or a refusal.
 *
 * The gateway signs UTF-8 JSON, so a body that is not exactly valid UTF-8 can
 * never be authentic. A lenient decoder would map invalid sequences to U+FFFD
 * and strip a leading BOM, so two DIFFERENT byte bodies could decode to the
 * same string and pass the same signature; `fatal` + `ignoreBOM` make the
 * decoding injective, and a failure is a signature failure.
 */
function decodeExactUtf8(payload: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
  } catch {
    throw new PeableSignatureVerificationError(
      'Webhook payload is not valid UTF-8, so it cannot be the signed body',
    );
  }
}
