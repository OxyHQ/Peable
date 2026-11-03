import { describe, expect, it } from 'bun:test';
import { cardIntentFixture, intentFixture } from './fixtures';
import { summarizePayments } from './summary';

describe('summarizePayments', () => {
  it('counts outcomes and sums the received volume per currency, exactly', () => {
    const summary = summarizePayments(
      [
        cardIntentFixture({
          id: 'a',
          status: 'succeeded',
          amount: '1250',
          amount_received: '1250',
          created: 30,
        }),
        // Refunded in full: still a success, and its money still counts as received.
        cardIntentFixture({
          id: 'b',
          status: 'succeeded',
          amount: '750',
          amount_received: '750',
          amount_refunded: '750',
          created: 20,
        }),
        intentFixture({
          id: 'c',
          status: 'succeeded',
          amount: '9007199254740993',
          amount_received: '9007199254740993',
        }),
        intentFixture({ id: 'd', status: 'processing', created: 10 }),
        intentFixture({
          id: 'e',
          status: 'canceled',
          cancellation_reason: 'abandoned',
          created: 40,
        }),
        intentFixture({
          id: 'f',
          status: 'canceled',
          cancellation_reason: 'underpaid',
          created: 50,
        }),
      ],
      false,
    );
    expect(summary).toMatchObject({
      sampleSize: 6,
      oldest: 10,
      newest: 1_000,
      complete: false,
      succeeded: 3,
      refunded: 1,
      open: 1,
      unsuccessful: 2,
    });
    expect(summary.volume).toEqual([
      { currency: 'EUR', amount: '2000', count: 2 },
      { currency: 'FAIR', amount: '9007199254740993', count: 1 },
    ]);
  });

  it('counts a partial capture by what it took, not what it asked', () => {
    const summary = summarizePayments(
      [cardIntentFixture({ status: 'succeeded', amount: '5000', amount_received: '3000' })],
      true,
    );
    expect(summary.volume).toEqual([{ currency: 'EUR', amount: '3000', count: 1 }]);
  });

  it('describes an empty sample without inventing dates', () => {
    expect(summarizePayments([], true)).toEqual({
      sampleSize: 0,
      oldest: null,
      newest: null,
      complete: true,
      succeeded: 0,
      open: 0,
      unsuccessful: 0,
      refunded: 0,
      volume: [],
    });
  });
});
