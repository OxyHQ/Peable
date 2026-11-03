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
  /**
   * The identity since ADR 0019 — Peable adopted Stripe's seven — and still
   * total over Stripe's union. `requires_capture` stays `requires_capture`: an
   * authorization NOT captured is never `succeeded`, which would settle an
   * order against money nobody has taken.
   */
  test('maps every status Stripe can report to itself', () => {
    for (const status of ALL_STRIPE_STATUSES) {
      expect(mapPaymentIntentStatus(status)).toBe(status);
    }
  });

  test('a payment_failed event reports a failed ATTEMPT, an authorization is requires_capture', () => {
    expect(
      toProviderEventEnvelope(eventWith({ type: 'payment_intent.payment_failed' })).paymentStatus,
    ).toBe('failed');
    expect(
      toProviderEventEnvelope(eventWith({ type: 'payment_intent.amount_capturable_updated' }))
        .paymentStatus,
    ).toBe('requires_capture');
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
