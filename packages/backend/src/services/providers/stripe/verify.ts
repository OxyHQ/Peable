/**
 * Stripe's vocabulary, mapped into the gateway's.
 *
 * Pure functions over an already-VERIFIED event. Signature verification lives in
 * `client.ts`; by the time anything here runs, the bytes have been proven to
 * come from Stripe. Keeping the two apart is what lets the mapping be tested
 * exhaustively without a signing key.
 *
 * Ported from Mercaria's `services/payments/stripe/verify.ts`.
 */

import type Stripe from 'stripe';
import type { ProviderEventEnvelope, ProviderPaymentStatus } from '../provider';

/**
 * Stripe's PaymentIntent status → the gateway's.
 *
 * The identity since ADR 0019 — the gateway adopted Stripe's seven statuses —
 * and still a TOTAL function over Stripe's own union, so a status Stripe adds
 * is a compile error here rather than a payment that silently maps to nothing.
 */
export function mapPaymentIntentStatus(status: Stripe.PaymentIntent.Status): ProviderPaymentStatus {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
    case 'requires_capture':
    case 'succeeded':
    case 'canceled':
      return status;
  }
}

/**
 * The event types that say something about a PAYMENT's state.
 *
 * `payment_failed` maps to `failed` — an ATTEMPT failed; the payment itself is
 * back at `requires_payment_method` and the drain records the error with it.
 */
const PAYMENT_STATUS_FOR_EVENT: Readonly<Record<string, ProviderPaymentStatus | 'failed'>> = {
  'payment_intent.succeeded': 'succeeded',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.processing': 'processing',
  'payment_intent.canceled': 'canceled',
  'payment_intent.requires_action': 'requires_action',
  'payment_intent.amount_capturable_updated': 'requires_capture',
};

/**
 * Pull out the provider object ids an event refers to.
 *
 * Recorded under Stripe's OWN names (`payment_intent`, `charge`, `refund`,
 * `transfer`, `account`) rather than translated: this is evidence, and evidence
 * that has been renamed is harder to reconcile against a Stripe dashboard when
 * somebody is trying to work out what happened.
 */
export function stripeObjectIds(event: Stripe.Event): Record<string, string> {
  const ids: Record<string, string> = {};
  // Through `unknown`: `event.data.object` is a union of ~80 Stripe resource
  // types, and TypeScript is right that none of them is an index signature.
  // Reading it as a bag is exactly what this function is for — it looks for a
  // handful of id fields across every event type without knowing which one
  // arrived, and every read below is guarded by a `typeof` check.
  const object = event.data.object as unknown as Record<string, unknown> & { id?: unknown };

  if (typeof object.id === 'string') {
    const objectType = typeof object.object === 'string' ? object.object : 'object';
    ids[objectType] = object.id;
  }
  // `invoice` names a credit note's invoice and `customer` lets a handler that
  // only acts for some customers answer locally, without a provider read.
  for (const key of [
    'payment_intent',
    'charge',
    'transfer',
    'source_transaction',
    'invoice',
    'customer',
  ]) {
    const value = object[key];
    if (typeof value === 'string') ids[key] = value;
  }
  if (event.account) ids.account = event.account;
  return ids;
}

/**
 * A verified Stripe event as a gateway envelope.
 *
 * `payload` is the parsed body and is NOT what gets stored wholesale — the
 * caller redacts first. It is on the envelope so a handler can read the fields
 * it needs.
 */
export function toProviderEventEnvelope(event: Stripe.Event): ProviderEventEnvelope {
  const paymentStatus = PAYMENT_STATUS_FOR_EVENT[event.type];
  return {
    provider: 'stripe',
    ...(event.account !== undefined ? { providerAccountId: event.account } : {}),
    providerEventId: event.id,
    type: event.type,
    livemode: event.livemode,
    ...(event.api_version !== null ? { apiVersion: event.api_version } : {}),
    objectIds: stripeObjectIds(event),
    ...(paymentStatus !== undefined ? { paymentStatus } : {}),
    payload: event,
  };
}

/**
 * Whether a verified event belongs to THIS deployment's mode.
 *
 * A production webhook URL receives test events too — Stripe delivers both to
 * an endpoint unless it is scoped, and an operator clicking "send test webhook"
 * in the dashboard produces one. Processing a test event on a live deployment
 * would settle a payment that does not exist, so this filter is not hygiene.
 *
 * It is also the reason `livemode` is DERIVED from the secret key rather than
 * configured: a deployment cannot claim one mode while holding the other's key.
 */
export function isExpectedLivemode(event: Stripe.Event, expectLive: boolean): boolean {
  return event.livemode === expectLive;
}
