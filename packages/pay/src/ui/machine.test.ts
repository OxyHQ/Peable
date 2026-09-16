import { describe, test, expect } from 'bun:test';
import { UNITS_PER_COIN, explorerTxUrl, parseFairCoinURI } from '@fairco.in/core';
import type { PaymentQuote } from '../payment';
import {
  handoffFor,
  initialPayState,
  paidFrom,
  payReducer,
  prepareFromQuote,
  sendRequestFor,
  type PayEvent,
  type PayState,
  type ReviewedPayment,
} from './machine';

const TO = 'fRecipientAddressForTests00000000';
const SEED = new Uint8Array(64).fill(3);

const REVIEWED: ReviewedPayment = {
  to: TO,
  amountSat: 2n * UNITS_PER_COIN,
  feeSat: 4_520n,
  totalSat: 2n * UNITS_PER_COIN + 4_520n,
  feePerByte: 12,
};

function run(state: PayState, ...events: PayEvent[]): PayState {
  return events.reduce(payReducer, state);
}

/** The amount step, with a valid amount typed and nothing in flight. */
function readyToContinue(text = '2'): PayState {
  return run(initialPayState(), { type: 'amount-typed', text });
}

describe('the happy path, end to end', () => {
  test('amount -> preparing -> review -> sending -> paid', () => {
    const typed = readyToContinue('2');
    expect(typed.step).toBe('amount');

    const preparing = payReducer(typed, { type: 'continue' });
    expect(preparing).toMatchObject({ step: 'preparing', amountSat: 2n * UNITS_PER_COIN });

    const review = payReducer(preparing, {
      type: 'prepared',
      attempt: preparing.attempt,
      reviewed: REVIEWED,
    });
    expect(review).toMatchObject({ step: 'review', reviewed: REVIEWED });

    const sending = payReducer(review, { type: 'confirm' });
    expect(sending.step).toBe('sending');

    const paid = payReducer(sending, {
      type: 'paid',
      attempt: sending.attempt,
      paid: paidFrom(REVIEWED, { txid: 'ab'.repeat(32), feeSat: 4_520n }),
    });
    expect(paid.step).toBe('paid');
  });

  test('a surface with no signer goes to the hand-off instead of a review', () => {
    const preparing = payReducer(readyToContinue('2'), { type: 'continue' });
    const handoff = payReducer(preparing, {
      type: 'handoff',
      attempt: preparing.attempt,
      offer: handoffFor(TO, 2n * UNITS_PER_COIN),
    });
    expect(handoff.step).toBe('handoff');
  });
});

describe('what can be sent', () => {
  /**
   * The rule the whole confirm step exists for. `sendPayment` re-fetches the
   * rate when `feePerByte` is omitted, so the fee on the receipt would be
   * whatever the Explorer said a second after the payer agreed to a different
   * number.
   */
  test('the request carries the exact rate the review was priced at', () => {
    const request = sendRequestFor(REVIEWED, SEED, 'mainnet');
    expect(request.feePerByte).toBe(REVIEWED.feePerByte);
    expect(request.amountSat).toBe(REVIEWED.amountSat);
    expect(request.to).toBe(REVIEWED.to);
    expect(request.feePerByte).not.toBeUndefined();
  });

  test('confirm carries the reviewed payment forward unchanged, by identity', () => {
    const review = payReducer(payReducer(readyToContinue(), { type: 'continue' }), {
      type: 'prepared',
      attempt: 1,
      reviewed: REVIEWED,
    });
    const sending = payReducer(review, { type: 'confirm' });
    expect(sending.step).toBe('sending');
    if (sending.step !== 'sending') throw new Error('unreachable');
    // Identity, not equality: a rebuilt object is how a confirm step and a send
    // start disagreeing one field at a time.
    expect(sending.reviewed).toBe(REVIEWED);
  });

  test('an amount that did not parse cannot start an attempt', () => {
    for (const text of ['', 'abc', '0', '0.000000001']) {
      const state = run(initialPayState(), { type: 'amount-typed', text }, { type: 'continue' });
      expect(state.step).toBe('amount');
    }
  });

  test('the amount field cannot be rewritten under a rendered quote', () => {
    const review = payReducer(payReducer(readyToContinue('2'), { type: 'continue' }), {
      type: 'prepared',
      attempt: 1,
      reviewed: REVIEWED,
    });
    const tampered = payReducer(review, { type: 'amount-typed', text: '999' });
    expect(tampered).toBe(review);
  });
});

describe('a superseded attempt decides nothing', () => {
  /**
   * Type 10, Continue, go back, type 2, Continue. The first quote resolves
   * second. Without the attempt filter the review screen renders a fee for 10
   * while the payer believes they are sending 2 — and `sendRequestFor` would
   * then send the 10.
   */
  test('a quote from an abandoned attempt cannot become the review', () => {
    const first = payReducer(readyToContinue('10'), { type: 'continue' });
    const staleAttempt = first.attempt;

    const second = run(
      first,
      { type: 'edit' },
      { type: 'amount-typed', text: '2' },
      { type: 'continue' },
    );
    expect(second.step).toBe('preparing');
    expect(second.attempt).not.toBe(staleAttempt);

    const late = payReducer(second, {
      type: 'prepared',
      attempt: staleAttempt,
      reviewed: { ...REVIEWED, amountSat: 10n * UNITS_PER_COIN },
    });
    expect(late).toBe(second);
  });

  test('a failure from an abandoned attempt does not replace the screen', () => {
    const first = payReducer(readyToContinue('10'), { type: 'continue' });
    const second = run(first, { type: 'edit' }, { type: 'continue' });

    const late = payReducer(second, {
      type: 'failed',
      attempt: first.attempt,
      failure: { kind: 'unknown', stage: 'prepare', title: 'x', detail: null },
    });
    expect(late).toBe(second);
  });

  /**
   * `restart` keeps counting rather than resetting to zero. Resetting would
   * hand out a second attempt 1 — the number a request still in flight from
   * before the restart is already stamped with.
   */
  test('restarting never reuses an attempt number', () => {
    const inFlight = payReducer(readyToContinue('2'), { type: 'continue' });
    const restarted = payReducer(inFlight, { type: 'restart' });
    const again = payReducer(
      payReducer(restarted, { type: 'amount-typed', text: '2' }),
      { type: 'continue' },
    );
    expect(again.attempt).not.toBe(inFlight.attempt);
  });

  test('a result for the right attempt but the wrong step is ignored', () => {
    // `paid` is only meaningful while sending; accepting it from `preparing`
    // would show a receipt for a transaction that was never built.
    const preparing = payReducer(readyToContinue('2'), { type: 'continue' });
    const bogus = payReducer(preparing, {
      type: 'paid',
      attempt: preparing.attempt,
      paid: paidFrom(REVIEWED, { txid: 'cd'.repeat(32), feeSat: 1n }),
    });
    expect(bogus).toBe(preparing);
  });
});

describe('recovery after a failure', () => {
  function failAt(stage: 'prepare' | 'send'): PayState {
    const base =
      stage === 'prepare'
        ? payReducer(readyToContinue('2'), { type: 'continue' })
        : payReducer(
            payReducer(payReducer(readyToContinue('2'), { type: 'continue' }), {
              type: 'prepared',
              attempt: 1,
              reviewed: REVIEWED,
            }),
            { type: 'confirm' },
          );
    return payReducer(base, {
      type: 'failed',
      attempt: base.attempt,
      failure: { kind: 'unknown', stage, title: 'x', detail: null },
    });
  }

  test('a failure before anything was signed goes back to the typed amount', () => {
    const failed = failAt('prepare');
    expect(failed).toMatchObject({ step: 'failed', recovery: 'edit' });

    const back = payReducer(failed, { type: 'edit' });
    expect(back).toMatchObject({ step: 'amount', input: '2' });
  });

  /**
   * After broadcast the inputs may already be spent; a one-tap retry would ask
   * the payer to send a second time on the strength of an outcome nobody knows.
   * The reducer refuses `edit` there so the only way on is `restart`, which
   * re-quotes against what actually happened.
   */
  test('a failure after broadcast refuses to be walked back into', () => {
    const failed = failAt('send');
    expect(failed).toMatchObject({ step: 'failed', recovery: 'restart' });
    expect(payReducer(failed, { type: 'edit' })).toBe(failed);

    const restarted = payReducer(failed, { type: 'restart' });
    expect(restarted).toMatchObject({ step: 'amount', input: '' });
  });

  test('a payment in flight cannot be edited out from under itself', () => {
    const sending = payReducer(
      payReducer(payReducer(readyToContinue('2'), { type: 'continue' }), {
        type: 'prepared',
        attempt: 1,
        reviewed: REVIEWED,
      }),
      { type: 'confirm' },
    );
    expect(payReducer(sending, { type: 'edit' })).toBe(sending);
  });

  test('a receipt is not editable', () => {
    const paid = payReducer(
      payReducer(
        payReducer(payReducer(readyToContinue('2'), { type: 'continue' }), {
          type: 'prepared',
          attempt: 1,
          reviewed: REVIEWED,
        }),
        { type: 'confirm' },
      ),
      { type: 'paid', attempt: 2, paid: paidFrom(REVIEWED, { txid: 'ef'.repeat(32), feeSat: 1n }) },
    );
    expect(payReducer(paid, { type: 'edit' })).toBe(paid);
  });
});

describe('prepareFromQuote', () => {
  const affordable: PaymentQuote = {
    feeSat: 4_520n,
    totalSat: 2n * UNITS_PER_COIN + 4_520n,
    insufficientFunds: false,
    maxSendableSat: 50n * UNITS_PER_COIN,
    feePerByte: 12,
  };

  test('an affordable quote becomes exactly what the review renders', () => {
    const outcome = prepareFromQuote(affordable, TO, 2n * UNITS_PER_COIN);
    expect(outcome).toEqual({ kind: 'review', reviewed: REVIEWED });
  });

  /**
   * `quotePayment` reports unaffordability as a flag with null amounts rather
   * than a throw. A review built from it would render an empty fee row over a
   * confirm button for a payment that cannot be built.
   */
  test('an unaffordable quote never becomes a review', () => {
    const outcome = prepareFromQuote(
      { ...affordable, feeSat: null, totalSat: null, insufficientFunds: true, maxSendableSat: 1n },
      TO,
      2n * UNITS_PER_COIN,
    );
    expect(outcome.kind).toBe('failed');
  });

  test('a null fee is refused even if the flag says otherwise', () => {
    const outcome = prepareFromQuote(
      { ...affordable, feeSat: null, totalSat: null },
      TO,
      2n * UNITS_PER_COIN,
    );
    expect(outcome.kind).toBe('failed');
  });
});

describe('paidFrom', () => {
  test('reports the fee the transaction paid, not the one forecast', () => {
    const paid = paidFrom(REVIEWED, { txid: 'ab'.repeat(32), feeSat: 4_600n });
    expect(paid.feeSat).toBe(4_600n);
    expect(paid.amountSat).toBe(REVIEWED.amountSat);
    expect(paid.explorerUrl).toBe(explorerTxUrl('ab'.repeat(32)));
  });
});

describe('handoffFor', () => {
  /**
   * BIP21's `amount` is whole coins. Writing base units into it would open the
   * payer's phone prefilled with a hundred million times the intended payment.
   */
  test('the URI amount is FAIR, and a wallet reads back what was asked for', () => {
    const offer = handoffFor(TO, 2n * UNITS_PER_COIN);
    const parsed = parseFairCoinURI(offer.uri);
    expect(parsed?.address).toBe(TO);
    expect(parsed?.amount).toBe('2.00000000');
    expect(Number(parsed?.amount)).toBe(2);
  });

  test('the amount carries no thousands separators a URI parser would drop', () => {
    const offer = handoffFor(TO, 12_345n * UNITS_PER_COIN);
    expect(offer.uri).not.toContain(',');
    expect(Number(parseFairCoinURI(offer.uri)?.amount)).toBe(12_345);
  });

  test('the source app rides along as the label only', () => {
    const offer = handoffFor(TO, UNITS_PER_COIN, 'mention');
    expect(parseFairCoinURI(offer.uri)?.label).toBe('mention');
    expect(parseFairCoinURI(offer.uri)?.address).toBe(TO);
  });
});
