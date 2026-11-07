/**
 * Stripe Identity in the gateway's vocabulary (ADR 0023): the adapter hands
 * over the verdict and nothing the person submitted, and "this account has no
 * Identity" is recognised as such.
 */
import { describe, expect, test } from 'bun:test';
import Stripe from 'stripe';
import { isIdentityUnavailableError } from '../client';
import { toStripeOptions, toVerificationSession, toVerifiedOutputs } from '../identity';
import { stripeObjectIds } from '../verify';

const PERSONAL = ['Jenny', 'Rosen', '1234 Main St.', 'file_doc_front', 'file_selfie', 'D1234567'];

function session(overrides: Record<string, unknown> = {}): Stripe.Identity.VerificationSession {
  return {
    id: 'vs_stripe_1',
    object: 'identity.verification_session',
    client_secret: 'vs_secret',
    created: 1793750400,
    last_error: { code: 'selfie_face_mismatch', reason: "The selfie didn't match" },
    last_verification_report: {
      id: 'vr_stripe_1',
      object: 'identity.verification_report',
      created: 1793750460,
      livemode: false,
      type: 'document',
      options: { document: {} },
      verification_session: 'vs_stripe_1',
      document: {
        status: 'verified',
        error: null,
        first_name: 'Jenny',
        last_name: 'Rosen',
        address: { line1: '1234 Main St.', city: 'SF', country: 'US' },
        files: ['file_doc_front'],
        number: 'D1234567',
        type: 'driving_license',
        issuing_country: 'US',
      },
      selfie: {
        status: 'unverified',
        error: { code: 'selfie_face_mismatch', reason: 'mismatch' },
        selfie: 'file_selfie',
        document: 'file_doc_front',
      },
      id_number: null,
    },
    livemode: false,
    metadata: { peable_verification_session_id: 'vs_orbit' },
    options: { document: { require_matching_selfie: true } },
    redaction: null,
    status: 'requires_input',
    type: 'document',
    url: 'https://verify.stripe.com/start/x',
    verified_outputs: {
      first_name: 'Jenny',
      last_name: 'Rosen',
      address: {
        line1: '1234 Main St.',
        line2: null,
        city: 'SF',
        state: 'CA',
        postal_code: '94111',
        country: 'US',
      },
      dob: { day: 1, month: 2, year: 1990 },
      id_number: '6789',
      id_number_type: 'us_ssn',
      email: null,
      phone: null,
    },
    ...overrides,
  } as unknown as Stripe.Identity.VerificationSession;
}

describe('the Stripe Identity adapter', () => {
  test('a session crosses as its verdict: codes, never prose, never the person', () => {
    const mapped = toVerificationSession(session());
    expect(mapped).toEqual({
      providerObjectId: 'vs_stripe_1',
      status: 'requires_input',
      type: 'document',
      lastError: { errorCode: 'selfie_face_mismatch' },
      clientSecret: 'vs_secret',
      url: 'https://verify.stripe.com/start/x',
      lastReport: {
        providerObjectId: 'vr_stripe_1',
        type: 'document',
        document: { status: 'verified', errorCode: null },
        idNumber: null,
        selfie: { status: 'unverified', errorCode: 'selfie_face_mismatch' },
      },
      redaction: null,
    });
    const serialized = JSON.stringify(mapped);
    for (const value of [...PERSONAL, "didn't match"]) expect(serialized).not.toContain(value);
  });

  test('an unknown failure code crosses as a failure without a code; `validated` is not a redaction', () => {
    const mapped = toVerificationSession(
      session({
        last_error: { code: 'brand_new_code', reason: 'x' },
        last_verification_report: 'vr_unexpanded',
        redaction: { status: 'validated' },
      }),
    );
    expect(mapped.lastError).toEqual({ errorCode: null });
    expect(mapped.lastReport).toBeNull();
    expect(mapped.redaction).toBeNull();
    expect(toVerificationSession(session({ redaction: { status: 'processing' } })).redaction).toBe(
      'processing',
    );
  });

  test('verified outputs leave only for the answer that asked, dob and id number only when named', () => {
    const plain = toVerifiedOutputs(session(), { dob: false, idNumber: false });
    expect(plain).toMatchObject({ firstName: 'Jenny', idNumberType: 'us_ssn' });
    expect(plain && 'dob' in plain).toBe(false);
    expect(plain && 'idNumber' in plain).toBe(false);
    const full = toVerifiedOutputs(session(), { dob: true, idNumber: true });
    expect(full).toMatchObject({ dob: { day: 1, month: 2, year: 1990 }, idNumber: '6789' });
    expect(
      toVerifiedOutputs(session({ verified_outputs: null }), { dob: true, idNumber: true }),
    ).toBeNull();
  });

  test('options: only a document session takes them, and only what was set is sent', () => {
    expect(
      toStripeOptions('id_number', { document: { requireLiveCapture: true } }),
    ).toBeUndefined();
    expect(
      toStripeOptions('document', {
        document: { allowedTypes: ['passport'], requireMatchingSelfie: true },
      }),
    ).toEqual({ document: { allowed_types: ['passport'], require_matching_selfie: true } });
  });

  test('"this account has no Identity" is recognised; an ordinary invalid request is not', () => {
    const raw = (type: string, message: string) => ({ type, message, statusCode: 400 }) as never;
    expect(
      isIdentityUnavailableError(
        new Stripe.errors.StripeInvalidRequestError(
          raw(
            'invalid_request_error',
            'Your account is not activated for Stripe Identity. Please apply...',
          ),
        ),
      ),
    ).toBe(true);
    expect(
      isIdentityUnavailableError(
        new Stripe.errors.StripePermissionError(raw('invalid_request_error', 'restricted key')),
      ),
    ).toBe(true);
    expect(
      isIdentityUnavailableError(
        new Stripe.errors.StripeInvalidRequestError(
          raw('invalid_request_error', 'No such verification session'),
        ),
      ),
    ).toBe(false);
  });

  test('the drain finds the session under its own object name', () => {
    const ids = stripeObjectIds({
      id: 'evt_1',
      account: undefined,
      data: { object: { id: 'vs_stripe_1', object: 'identity.verification_session' } },
    } as unknown as Stripe.Event);
    expect(ids['identity.verification_session']).toBe('vs_stripe_1');
  });
});
