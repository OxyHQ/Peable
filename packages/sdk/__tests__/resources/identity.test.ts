/**
 * Identity verification (Stripe's `identity.*`, ADR 0023): the generated
 * methods reach the right routes, a create and every write send an
 * idempotency key, and a retrieve asks for the verified data by `expand[]`.
 */
import { describe, expect, test } from 'bun:test';
import type { VerificationReport, VerificationSession } from '@peable.to/shared-types';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import { buildTestClient, resources, serviceTokenMintResponse } from '../support/testGateway';

const SESSION: VerificationSession = {
  id: 'vs_1',
  object: 'identity.verification_session',
  livemode: false,
  type: 'document',
  status: 'requires_input',
  options: {
    document: {
      allowed_types: null,
      require_id_number: null,
      require_live_capture: null,
      require_matching_selfie: true,
    },
  },
  client_secret: 'vs_secret',
  url: 'https://verify.example/x',
  return_url: null,
  client_reference_id: 'user_42',
  last_error: null,
  last_verification_report: null,
  redaction: null,
  metadata: {},
  created: 1_793_750_400,
};

const REPORT: VerificationReport = {
  id: 'vr_1',
  object: 'identity.verification_report',
  livemode: false,
  type: 'document',
  verification_session: 'vs_1',
  options: SESSION.options,
  document: { status: 'verified', error: null },
  id_number: null,
  selfie: { status: 'verified', error: null },
  created: 1_793_750_460,
};

function gateway(body: unknown) {
  return createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    return { status: 200, json: body };
  });
}

function callOf(requests: CapturedRequest[]): CapturedRequest {
  const call = requests.find((r) => !r.url.includes('/auth/service-token'));
  if (!call) throw new Error('no gateway call was made');
  return call;
}

describe('identity.verificationSessions', () => {
  test('create posts the type and options with an idempotency key', async () => {
    const mock = gateway(SESSION);
    const session = await resources(
      buildTestClient(mock.fetch),
    ).identity.verificationSessions.create({
      type: 'document',
      options: { document: { require_matching_selfie: true } },
      client_reference_id: 'user_42',
    });
    expect(session.url).toBe('https://verify.example/x');
    const call = callOf(mock.requests);
    expect([call.method, new URL(call.url).pathname]).toEqual([
      'POST',
      '/v1/identity/verification_sessions',
    ]);
    expect(JSON.parse(call.body ?? '{}')).toEqual({
      type: 'document',
      options: { document: { require_matching_selfie: true } },
      client_reference_id: 'user_42',
    });
    expect(call.headers.get('Idempotency-Key')).toBeTruthy();
  });

  test('retrieve with verified_outputs, cancel and redact', async () => {
    const one = gateway(SESSION);
    await resources(buildTestClient(one.fetch)).identity.verificationSessions.retrieve('vs_1', {
      expand: ['verified_outputs'],
    });
    const url = new URL(callOf(one.requests).url);
    expect(url.pathname).toBe('/v1/identity/verification_sessions/vs_1');
    expect(url.search).toContain('verified_outputs');

    for (const action of ['cancel', 'redact'] as const) {
      const mock = gateway({ ...SESSION, status: 'canceled' });
      await resources(buildTestClient(mock.fetch)).identity.verificationSessions[action]('vs_1');
      const call = callOf(mock.requests);
      expect([call.method, new URL(call.url).pathname]).toEqual([
        'POST',
        `/v1/identity/verification_sessions/vs_1/${action}`,
      ]);
      expect(call.headers.get('Idempotency-Key')).toBeTruthy();
    }
  });
});

describe('identity.verificationReports', () => {
  test('list by session and retrieve', async () => {
    const many = gateway({ object: 'list', data: [REPORT], has_more: false, url: '/x' });
    const page = await resources(buildTestClient(many.fetch)).identity.verificationReports.list({
      verification_session: 'vs_1',
    });
    expect(page.data[0]?.document?.status).toBe('verified');
    const listUrl = new URL(callOf(many.requests).url);
    expect(listUrl.pathname).toBe('/v1/identity/verification_reports');
    expect(listUrl.searchParams.get('verification_session')).toBe('vs_1');

    const one = gateway(REPORT);
    await resources(buildTestClient(one.fetch)).identity.verificationReports.retrieve('vr_1');
    expect(new URL(callOf(one.requests).url).pathname).toBe(
      '/v1/identity/verification_reports/vr_1',
    );
  });
});
