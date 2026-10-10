/**
 * The status mapping and the event envelope.
 *
 * Pure functions over an already-verified event, so they can be walked
 * exhaustively without a signing key — and they must be, because this is where
 * a mistake means calling a payment settled that is not.
 */
import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import {
  isExpectedLivemode,
  mapPaymentIntentStatus,
  stripeObjectIds,
  toProviderEventEnvelope,
} from '../verify';

/** Every status Stripe's own union declares. A new one is a compile error. */
const ALL_STRIPE_STATUSES: readonly Stripe.PaymentIntent.Status[] = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'succeeded',
  'canceled',
];

function eventWith(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: 'evt_1',
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: 1_700_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_1', object: 'payment_intent' } },
    ...overrides,
  } as unknown as Stripe.Event;
}

describe('mapPaymentIntentStatus', () => {
  test('maps every status Stripe can report', () => {
    for (const status of ALL_STRIPE_STATUSES) {
      expect(typeof mapPaymentIntentStatus(status)).toBe('string');
    }
  });

  /**
   * The one that would settle an order against money nobody has taken.
   * `requires_capture` means authorized and NOT captured.
   */
  test('requires_capture is processing, never succeeded', () => {
    expect(mapPaymentIntentStatus('requires_capture')).toBe('processing');
  });

  /**
   * And the one that would close intents nobody has tried to pay. A payer who
   * abandoned a checkout and a payer whose card was declined both land on
   * `requires_payment_method`.
   */
  test('requires_payment_method is created, never failed', () => {
    expect(mapPaymentIntentStatus('requires_payment_method')).toBe('created');
    expect(mapPaymentIntentStatus('requires_confirmation')).toBe('created');
  });

  test('succeeded and canceled carry across unchanged', () => {
    expect(mapPaymentIntentStatus('succeeded')).toBe('succeeded');
    expect(mapPaymentIntentStatus('canceled')).toBe('canceled');
    expect(mapPaymentIntentStatus('requires_action')).toBe('requires_action');
    expect(mapPaymentIntentStatus('processing')).toBe('processing');
  });
});

describe('toProviderEventEnvelope', () => {
  test('carries the ids, the mode and the mapped payment status', () => {
    const envelope = toProviderEventEnvelope(eventWith());

    expect(envelope.provider).toBe('stripe');
    expect(envelope.providerEventId).toBe('evt_1');
    expect(envelope.type).toBe('payment_intent.succeeded');
    expect(envelope.livemode).toBe(false);
    expect(envelope.paymentStatus).toBe('succeeded');
    expect(envelope.objectIds).toMatchObject({ payment_intent: 'pi_1' });
  });

  /**
   * An event the gateway cannot act on still becomes an envelope.
   *
   * `paymentStatus` absent is the whole distinction: the event is EVIDENCE and
   * gets stored, it just moves no payment. Dropping such events would leave a
   * reconciliation with nothing to compare against.
   */
  test('an event about something other than a payment carries no payment status', () => {
    const envelope = toProviderEventEnvelope(
      eventWith({
        type: 'payout.paid',
        data: { object: { id: 'po_1', object: 'payout' } },
      } as Partial<Stripe.Event>),
    );

    expect(envelope.paymentStatus).toBeUndefined();
    expect(envelope.type).toBe('payout.paid');
    expect(envelope.objectIds).toMatchObject({ payout: 'po_1' });
  });

  test('a connect-scope event carries the account it is about', () => {
    const envelope = toProviderEventEnvelope(
      eventWith({ account: 'acct_1', type: 'account.updated' } as Partial<Stripe.Event>),
    );

    expect(envelope.providerAccountId).toBe('acct_1');
    expect(envelope.objectIds.account).toBe('acct_1');
  });
});

describe('stripeObjectIds', () => {
  test("picks up a referenced payment intent as well as the object's own id", () => {
    const ids = stripeObjectIds(
      eventWith({
        type: 'charge.refunded',
        data: {
          object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_9' },
        },
      } as Partial<Stripe.Event>),
    );

    expect(ids).toMatchObject({ charge: 'ch_1', payment_intent: 'pi_9' });
  });

  /** An expanded object is not a string, and recording `[object Object]` as an id would be worse than recording nothing. */
  test('ignores an expanded reference rather than stringifying it', () => {
    const ids = stripeObjectIds(
      eventWith({
        data: {
          object: {
            id: 'ch_1',
            object: 'charge',
            payment_intent: { id: 'pi_9', object: 'payment_intent' },
          },
        },
      } as Partial<Stripe.Event>),
    );

    expect(ids.payment_intent).toBeUndefined();
    expect(ids.charge).toBe('ch_1');
  });
});

describe('isExpectedLivemode', () => {
  /**
   * A production webhook URL receives test events too — an operator clicking
   * "send test webhook" produces one. Processing it on a live deployment would
   * settle a payment that does not exist.
   */
  test('refuses an event from the other mode, in both directions', () => {
    expect(isExpectedLivemode(eventWith({ livemode: false }), true)).toBe(false);
    expect(isExpectedLivemode(eventWith({ livemode: true }), false)).toBe(false);
    expect(isExpectedLivemode(eventWith({ livemode: true }), true)).toBe(true);
    expect(isExpectedLivemode(eventWith({ livemode: false }), false)).toBe(true);
  });
});
