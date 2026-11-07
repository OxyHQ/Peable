import { describe, expect, it } from 'bun:test';
import {
  VERIFICATION_DOCUMENT_TYPES,
  VERIFICATION_SESSION_LIMITS,
  VERIFICATION_SESSION_STATUSES,
  VERIFICATION_SESSION_TYPES,
} from '@peable.to/shared-types';
import { OrbitApiError } from '../api/transport';
import {
  buildVerificationBody,
  checkStatusTone,
  EMPTY_VERIFICATION_FORM,
  hostedLinkOf,
  identityRefusal,
  isReturnUrl,
  ORBIT_DOCUMENT_TYPES,
  ORBIT_VERIFICATION_LIMITS,
  ORBIT_VERIFICATION_STATUSES,
  ORBIT_VERIFICATION_TYPES,
  redactWaitsForProcessing,
  verificationActions,
  verificationStatusTone,
} from './identityForm';

describe('the restated value sets', () => {
  it('match shared-types', () => {
    expect([...ORBIT_VERIFICATION_STATUSES]).toEqual([...VERIFICATION_SESSION_STATUSES]);
    expect([...ORBIT_VERIFICATION_TYPES]).toEqual([...VERIFICATION_SESSION_TYPES]);
    expect([...ORBIT_DOCUMENT_TYPES]).toEqual([...VERIFICATION_DOCUMENT_TYPES]);
    expect(ORBIT_VERIFICATION_LIMITS).toEqual(VERIFICATION_SESSION_LIMITS);
  });
});

describe('buildVerificationBody', () => {
  it('sends only the type for an untouched form', () => {
    expect(buildVerificationBody(EMPTY_VERIFICATION_FORM)).toEqual({
      ok: true,
      body: { type: 'document' },
    });
  });

  it('sends the document options turned on, deduplicated, and the trimmed fields', () => {
    expect(
      buildVerificationBody({
        ...EMPTY_VERIFICATION_FORM,
        allowedTypes: ['passport', 'passport', 'id_card'],
        requireLiveCapture: true,
        requireMatchingSelfie: true,
        returnUrl: ' https://shop.example/verified ',
        clientReferenceId: ' user_42 ',
      }),
    ).toEqual({
      ok: true,
      body: {
        type: 'document',
        options: {
          document: {
            allowed_types: ['passport', 'id_card'],
            require_live_capture: true,
            require_matching_selfie: true,
          },
        },
        return_url: 'https://shop.example/verified',
        client_reference_id: 'user_42',
      },
    });
  });

  it('never sends document options on an ID number session', () => {
    expect(
      buildVerificationBody({
        ...EMPTY_VERIFICATION_FORM,
        type: 'id_number',
        requireLiveCapture: true,
        allowedTypes: ['passport'],
      }),
    ).toEqual({ ok: true, body: { type: 'id_number' } });
  });

  it('refuses what the gateway would refuse', () => {
    expect(
      buildVerificationBody({ ...EMPTY_VERIFICATION_FORM, returnUrl: 'http://shop.example' }),
    ).toEqual({ ok: false, error: 'returnUrl' });
    expect(
      buildVerificationBody({ ...EMPTY_VERIFICATION_FORM, clientReferenceId: 'x'.repeat(256) }),
    ).toEqual({ ok: false, error: 'clientReferenceId' });
    expect(isReturnUrl('http://localhost:3000/back')).toBe(true);
    expect(isReturnUrl('not a url')).toBe(false);
  });
});

describe('what a session allows', () => {
  it('cancels only while requires_input and redacts anything not processing', () => {
    expect(verificationActions({ status: 'requires_input', redaction: null })).toEqual([
      'cancel',
      'redact',
    ]);
    expect(verificationActions({ status: 'processing', redaction: null })).toEqual([]);
    expect(verificationActions({ status: 'verified', redaction: null })).toEqual(['redact']);
    expect(verificationActions({ status: 'canceled', redaction: null })).toEqual(['redact']);
    expect(
      verificationActions({ status: 'canceled', redaction: { status: 'processing' } }),
    ).toEqual([]);
    expect(redactWaitsForProcessing({ status: 'processing', redaction: null })).toBe(true);
    expect(redactWaitsForProcessing({ status: 'verified', redaction: null })).toBe(false);
  });

  it('shows the hosted link only while the person can still open it', () => {
    const url = 'https://verify.example/x';
    expect(hostedLinkOf({ status: 'requires_input', redaction: null, url })).toBe(url);
    expect(hostedLinkOf({ status: 'verified', redaction: null, url })).toBeNull();
    expect(
      hostedLinkOf({ status: 'requires_input', redaction: { status: 'processing' }, url }),
    ).toBeNull();
  });

  it('gives each status and check a tone', () => {
    expect(ORBIT_VERIFICATION_STATUSES.map(verificationStatusTone)).toEqual([
      'warning',
      'info',
      'success',
      'neutral',
    ]);
    expect(checkStatusTone('verified')).toBe('success');
    expect(checkStatusTone('unverified')).toBe('danger');
  });
});

describe('identityRefusal', () => {
  const refusal = (status: number, code: string) =>
    new OrbitApiError({ status, type: 'api_error', message: 'm', code });
  it('names the two identity refusals and nothing else', () => {
    expect(identityRefusal(refusal(503, 'identity_unavailable'))).toBe('unavailable');
    expect(identityRefusal(refusal(409, 'verification_session_unexpected_state'))).toBe('state');
    expect(identityRefusal(refusal(400, 'parameter_invalid'))).toBeNull();
    expect(identityRefusal(new Error('x'))).toBeNull();
  });
});
