import { describe, expect, it } from 'bun:test';
import { intentFixture } from './fixtures';
import { paymentTimeline } from './timeline';

const keysAndStates = (steps: ReturnType<typeof paymentTimeline>) =>
  steps.map((step) => `${step.key}:${step.state}`);

describe('paymentTimeline', () => {
  it('shows a fresh chain payment as created, the chain steps ahead, and its expiry', () => {
    const steps = paymentTimeline(intentFixture());
    expect(keysAndStates(steps)).toEqual([
      'created:current',
      'broadcast:upcoming',
      'confirming:upcoming',
      'settled:upcoming',
      'expires:upcoming',
    ]);
    expect(steps[0]?.at).toBe(1_000);
    expect(steps[4]?.at).toBe(2_000);
  });

  it('carries the txid and the confirmation count on the chain steps', () => {
    const steps = paymentTimeline(
      intentFixture({ status: 'confirming', txid: 'abc', confirmations: 2, can_expire: false }),
    );
    expect(keysAndStates(steps)).toEqual([
      'created:done',
      'broadcast:done',
      'confirming:current',
      'settled:upcoming',
    ]);
    expect(steps[1]?.detail).toBe('Transaction abc');
    expect(steps[1]?.at).toBeUndefined();
    expect(steps[2]?.detail).toBe('2 confirmations');
    expect(steps[2]?.at).toBe(1_500);
  });

  it('draws a detour only when the payment is on it', () => {
    expect(keysAndStates(paymentTimeline(intentFixture({ status: 'awaiting_approval' })))).toEqual([
      'created:done',
      'awaiting_approval:current',
      'broadcast:upcoming',
      'confirming:upcoming',
      'settled:upcoming',
      'expires:upcoming',
    ]);
  });

  it('walks the card rail and ends settled as done', () => {
    const card = intentFixture({ rail: 'card', currency: 'EUR', network: null, address: null });
    expect(keysAndStates(paymentTimeline({ ...card, status: 'settled' }))).toEqual([
      'created:done',
      'processing:done',
      'settled:done',
    ]);
  });

  it('appends a refund after settlement', () => {
    const card = intentFixture({ rail: 'card', status: 'partially_refunded' });
    expect(keysAndStates(paymentTimeline(card))).toEqual([
      'created:done',
      'processing:done',
      'settled:done',
      'partially_refunded:done',
    ]);
  });

  it('ends a failed chain payment after the broadcast it reported', () => {
    const steps = paymentTimeline(intentFixture({ status: 'failed', txid: 'abc' }));
    expect(keysAndStates(steps)).toEqual(['created:done', 'broadcast:done', 'failed:failed']);
    expect(steps[2]?.at).toBe(1_500);
  });

  it('ends an expired payment right after creation, with no expiry still ahead', () => {
    expect(keysAndStates(paymentTimeline(intentFixture({ status: 'expired' })))).toEqual([
      'created:done',
      'expired:failed',
    ]);
  });
});
