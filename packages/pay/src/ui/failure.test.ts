import { describe, test, expect } from 'bun:test';
import {
  classifyPayFailure,
  insufficientFundsFailure,
  isKeylessRecipient,
  recoveryFor,
} from './failure';

describe('isKeylessRecipient', () => {
  /**
   * One gateway answer, four client shapes. Recognising only the one THIS repo's
   * frontend throws would turn an expected, explainable state into a crash
   * message for every other caller.
   */
  test('recognises every shape the gateway 409 reaches a caller in', () => {
    const named = new Error('@ana has not set up an Oxy identity yet');
    named.name = 'KeylessRecipientError';

    expect(isKeylessRecipient(named)).toBe(true);
    expect(isKeylessRecipient({ status: 409 })).toBe(true);
    expect(isKeylessRecipient({ type: 'keyless_recipient' })).toBe(true);
    expect(isKeylessRecipient({ code: 'keyless_recipient' })).toBe(true);
    expect(isKeylessRecipient({ error: { type: 'keyless_recipient' } })).toBe(true);
  });

  test('does not claim unrelated failures', () => {
    expect(isKeylessRecipient(new Error('Network request failed'))).toBe(false);
    expect(isKeylessRecipient({ status: 429 })).toBe(false);
    expect(isKeylessRecipient({ status: 500 })).toBe(false);
    expect(isKeylessRecipient(null)).toBe(false);
    expect(isKeylessRecipient('409')).toBe(false);
  });
});

describe('classifyPayFailure', () => {
  test('a keyless recipient is said plainly and carries no raw error text', () => {
    const failure = classifyPayFailure('resolve', { status: 409 });
    expect(failure.kind).toBe('recipient-cannot-receive');
    expect(failure.title).toBe("They can't receive payments yet");
    expect(failure.detail).toBeNull();
  });

  /**
   * 409 means keyless only on the reservation call. Classifying it that way in
   * a later stage would tell a payer the recipient cannot receive because a
   * broadcast hit an unrelated conflict.
   */
  test('a 409 outside the resolve stage is not a keyless recipient', () => {
    expect(classifyPayFailure('send', { status: 409 }).kind).not.toBe('recipient-cannot-receive');
  });

  test("the selector's insufficient-funds message becomes the payer's sentence", () => {
    const failure = classifyPayFailure(
      'prepare',
      new Error('Insufficient funds in selected coins: need 1234 m⊜, selected 900 m⊜'),
    );
    expect(failure.kind).toBe('insufficient-funds');
  });

  test('both ways the fee can be unavailable land on one answer', () => {
    expect(classifyPayFailure('prepare', new Error('fee estimate failed: HTTP 404')).kind).toBe(
      'no-fee-rate',
    );
    expect(
      classifyPayFailure('prepare', new Error('fee estimate returned no usable feePerByte')).kind,
    ).toBe('no-fee-rate');
    expect(
      classifyPayFailure('prepare', new Error('feePerByte must be a positive number, got 0')).kind,
    ).toBe('no-fee-rate');
  });

  /**
   * The stage-aware fallback. Nothing local throws during broadcast, so an
   * unrecognised send-stage error IS the daemon's answer — and the daemon's
   * message is arbitrary, which is exactly why it cannot be pattern-matched.
   */
  test('an unrecognised send-stage error is reported as the network refusing it', () => {
    const failure = classifyPayFailure('send', new Error('bad-txns-inputs-missingorspent'));
    expect(failure.kind).toBe('broadcast-rejected');
    expect(failure.detail).toBe('bad-txns-inputs-missingorspent');
  });

  /**
   * The counter-case that keeps the fallback honest: a local guard failing means
   * a defect here, and calling it a network rejection is both false and
   * un-debuggable.
   */
  test("a local refusal is not blamed on the network", () => {
    for (const message of [
      'Refusing to send: change address is not owned by this wallet',
      'Refusing to send: transaction pays 10 but selection quoted 9',
      'Cannot sign for fXyz: not an address of this wallet',
      'No selected UTXO for input abc:0',
    ]) {
      const failure = classifyPayFailure('send', new Error(message));
      expect(failure.kind).toBe('unknown');
      expect(failure.detail).toBe(message);
    }
  });

  test('a transport failure is separated from a rejection', () => {
    expect(classifyPayFailure('prepare', new Error('Network request failed')).kind).toBe(
      'unavailable',
    );
    expect(classifyPayFailure('resolve', new TypeError('fetch failed')).kind).toBe('unavailable');
  });

  test('a non-Error rejection still produces a sentence', () => {
    expect(classifyPayFailure('prepare', undefined)).toEqual({
      kind: 'unknown',
      stage: 'prepare',
      title: 'Something went wrong',
      detail: null,
    });
    expect(classifyPayFailure('prepare', { message: 'boom' }).detail).toBe('boom');
  });
});

describe('insufficientFundsFailure', () => {
  test('answers with the largest amount that would go through', () => {
    const failure = insufficientFundsFailure(150_000_000n);
    expect(failure.kind).toBe('insufficient-funds');
    expect(failure.detail).toContain('1.5');
  });
});

describe('recoveryFor', () => {
  /**
   * The money rule, not a layout preference: after broadcast a lost response is
   * indistinguishable from a rejection, so the same signed inputs may already be
   * spent. Only starting over re-reads the chain.
   */
  test('a failure after broadcast never resumes the same payment', () => {
    expect(recoveryFor('send')).toBe('restart');
    expect(recoveryFor('resolve')).toBe('edit');
    expect(recoveryFor('prepare')).toBe('edit');
  });
});
