import { describe, expect, it } from 'bun:test';
import { intentFixture } from './fixtures';
import { summarizePayments } from './summary';

describe('summarizePayments', () => {
  it('counts outcomes and sums gross volume per currency, exactly', () => {
    const summary = summarizePayments(
      [
        intentFixture({ id: 'a', status: 'settled', currency: 'EUR', amount: '1250', created: 30 }),
        intentFixture({ id: 'b', status: 'refunded', currency: 'EUR', amount: '750', created: 20 }),
        intentFixture({ id: 'c', status: 'settled', currency: 'FAIR', amount: '9007199254740993' }),
        intentFixture({ id: 'd', status: 'confirming', created: 10 }),
        intentFixture({ id: 'e', status: 'expired', created: 40 }),
        intentFixture({ id: 'f', status: 'failed', created: 50 }),
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
