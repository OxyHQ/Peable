import { describe, expect, it } from 'bun:test';
import { cardIntentFixture, intentFixture } from './fixtures';
import { paymentTimeline } from './timeline';

const keysAndStates = (steps: ReturnType<typeof paymentTimeline>) =>
  steps.map((step) => `${step.key}:${step.state}`);

describe('paymentTimeline', () => {
  it('shows a fresh chain payment waiting on its payer, the chain steps ahead, and its expiry', () => {
    const steps = paymentTimeline(intentFixture());
    expect(keysAndStates(steps)).toEqual([
      'requires_action:current',
      'processing:upcoming',
      'succeeded:upcoming',
      'expires:upcoming',
    ]);
    expect(steps[0]?.at).toBe(1_000);
    expect(steps[3]?.at).toBe(2_000);
  });

  it('carries the txid and the confirmation count on the processing step', () => {
    const steps = paymentTimeline(
      intentFixture({
        status: 'processing',
        can_expire: false,
        faircoin: {
          network: 'testnet',
          address: 'TAddress',
          outputs: [{ address: 'TAddress', amount: '100', connected_account: null }],
          txid: 'abc',
          confirmations: 1,
          required_confirmations: 2,
          quote: null,
        },
      }),
    );
    expect(keysAndStates(steps)).toEqual([
      'requires_action:done',
      'processing:current',
      'succeeded:upcoming',
    ]);
    expect(steps[1]?.detail).toBe('Transaction abc · 1 of 2 confirmations');
    expect(steps[1]?.at).toBe(1_500);
  });

  it('walks the card rail, a detour drawn only when the payment is on it', () => {
    expect(
      keysAndStates(paymentTimeline(cardIntentFixture({ status: 'requires_action' }))),
    ).toEqual([
      'requires_payment_method:done',
      'requires_action:current',
      'processing:upcoming',
      'succeeded:upcoming',
      'expires:upcoming',
    ]);
    expect(
      keysAndStates(
        paymentTimeline(
          cardIntentFixture({ status: 'succeeded', can_expire: false, amount_received: '2500' }),
        ),
      ),
    ).toEqual(['requires_payment_method:done', 'processing:done', 'succeeded:done']);
  });

  it('shows a held authorization on a manual-capture card payment', () => {
    expect(
      keysAndStates(
        paymentTimeline(
          cardIntentFixture({
            status: 'requires_capture',
            capture_method: 'manual',
            can_expire: false,
          }),
        ),
      ),
    ).toEqual([
      'requires_payment_method:done',
      'processing:done',
      'requires_capture:current',
      'succeeded:upcoming',
    ]);
  });

  it('says why the last card attempt failed while the payment is still payable', () => {
    const steps = paymentTimeline(
      cardIntentFixture({
        last_payment_error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'The card has insufficient funds.',
        },
      }),
    );
    expect(steps[0]?.detail).toBe('Last attempt failed: The card has insufficient funds.');
  });

  it('appends money back as an amount, never as a status', () => {
    const steps = paymentTimeline(
      cardIntentFixture({
        status: 'succeeded',
        can_expire: false,
        amount_received: '2500',
        amount_refunded: '1000',
      }),
    );
    expect(keysAndStates(steps).at(-1)).toBe('refunded:done');
    expect(steps.at(-1)?.label).toBe('Partially refunded');
    expect(steps.at(-1)?.at).toBeUndefined();
  });

  it('ends an underpaid chain payment after the transaction it reported, with the reason', () => {
    const steps = paymentTimeline(
      intentFixture({
        status: 'canceled',
        cancellation_reason: 'underpaid',
        canceled_at: 1_700,
        can_expire: false,
        faircoin: {
          network: 'testnet',
          address: 'TAddress',
          outputs: [{ address: 'TAddress', amount: '100', connected_account: null }],
          txid: 'abc',
          confirmations: 1,
          required_confirmations: 2,
          quote: null,
        },
      }),
    );
    expect(keysAndStates(steps)).toEqual([
      'requires_action:done',
      'processing:done',
      'canceled:failed',
    ]);
    expect(steps[2]?.at).toBe(1_700);
    expect(steps[2]?.detail).toBe('Underpaid');
  });

  it('ends an expired payment right after creation, with no expiry still ahead', () => {
    const steps = paymentTimeline(
      intentFixture({ status: 'canceled', cancellation_reason: 'abandoned', can_expire: false }),
    );
    expect(keysAndStates(steps)).toEqual(['requires_action:done', 'canceled:failed']);
    expect(steps[1]?.detail).toBe('Expired unpaid');
  });
});
