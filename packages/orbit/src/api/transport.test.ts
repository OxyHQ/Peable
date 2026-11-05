import { describe, expect, it, mock } from 'bun:test';
import type { AuthenticatedResponseRequest } from '@oxy.so/core';
import {
  createOrbitTransport,
  describeError,
  isOrbitApiError,
  OrbitApiError,
  withQuery,
} from './transport';
import { errorState } from '../ui/errorState';

function fakeClient(response: Response) {
  const calls: AuthenticatedResponseRequest[] = [];
  const requestAuthenticatedResponse = mock(async (request: AuthenticatedResponseRequest) => {
    calls.push(request);
    return response;
  });
  return { client: { requestAuthenticatedResponse }, calls };
}

describe('withQuery', () => {
  it('appends defined values in order and drops undefined and null', () => {
    expect(withQuery('/v1/x', { a: 'one', b: undefined, c: 2, d: null, e: false })).toBe(
      '/v1/x?a=one&c=2&e=false',
    );
  });

  it('joins onto an existing query string', () => {
    expect(withQuery('/v1/x?environment=production', { limit: 10 })).toBe(
      '/v1/x?environment=production&limit=10',
    );
  });

  it('leaves the path alone when nothing is left to add', () => {
    expect(withQuery('/v1/x', { a: undefined })).toBe('/v1/x');
    expect(withQuery('/v1/x', undefined)).toBe('/v1/x');
  });
});

describe('createOrbitTransport', () => {
  it('keeps a list envelope whole, has_more included', async () => {
    // The linked client's own helpers would have unwrapped this to the bare
    // array and lost `has_more`; the raw response must not.
    const page = { object: 'list', data: [{ id: 'pi_1' }], has_more: true };
    const { client, calls } = fakeClient(Response.json(page));
    const result = await createOrbitTransport(client).request('GET', '/v1/list', {
      query: { limit: 1 },
    });
    expect(result).toEqual(page);
    expect(calls).toEqual([{ method: 'GET', url: '/v1/list?limit=1' }]);
  });

  it('sends a JSON body with its content type, and the idempotency key when given', async () => {
    const { client, calls } = fakeClient(Response.json({ id: 'merch_1' }, { status: 201 }));
    await createOrbitTransport(client).request('POST', '/v1/merchant', {
      body: { webhook_url: 'https://example.com/hook' },
      idempotencyKey: 'key-1',
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/v1/merchant',
      body: '{"webhook_url":"https://example.com/hook"}',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' },
    });
  });

  it('sends a form as a replayable body factory with no content type of its own', async () => {
    const { client, calls } = fakeClient(Response.json({ id: 'file_1' }, { status: 200 }));
    let built = 0;
    const form = () => {
      built += 1;
      const data = new FormData();
      data.append('purpose', 'dispute_evidence');
      return data;
    };
    await createOrbitTransport(client).request('POST', '/v1/files', { form });
    const sent = calls[0];
    expect(sent?.body).toBeUndefined();
    expect(sent?.headers).toBeUndefined();
    expect(typeof sent?.bodyFactory).toBe('function');
    expect(sent?.bodyFactory?.()).toBeInstanceOf(FormData);
    expect(built).toBe(1);
  });

  it('refuses a request with both a JSON body and a form', async () => {
    const { client } = fakeClient(Response.json({}));
    await expect(
      createOrbitTransport(client).request('POST', '/v1/files', {
        body: {},
        form: () => new FormData(),
      }),
    ).rejects.toThrow('never both');
  });

  it('answers undefined for an empty success', async () => {
    const { client } = fakeClient(new Response(null, { status: 204 }));
    expect(await createOrbitTransport(client).request('DELETE', '/v1/x')).toBeUndefined();
  });

  it('turns an ADR 0014 error envelope into an OrbitApiError with its request id', async () => {
    const { client } = fakeClient(
      Response.json(
        {
          error: {
            type: 'invalid_request_error',
            code: 'parameter_invalid',
            param: 'webhook_url',
            message: 'webhook_url must be a URL',
            request_id: 'req_123',
          },
        },
        { status: 400 },
      ),
    );
    const error = await createOrbitTransport(client)
      .request('PATCH', '/v1/merchant', { body: {} })
      .catch((e: unknown) => e);
    expect(isOrbitApiError(error)).toBe(true);
    const api = error as OrbitApiError;
    expect(api.status).toBe(400);
    expect(api.type).toBe('invalid_request_error');
    expect(api.code).toBe('parameter_invalid');
    expect(api.param).toBe('webhook_url');
    expect(api.requestId).toBe('req_123');
    expect(describeError(api, 'fallback')).toBe('webhook_url must be a URL (request req_123)');
  });

  it('falls back to the Request-Id header and the status when the body is not an envelope', async () => {
    const { client } = fakeClient(
      new Response('<html>bad gateway</html>', { status: 502, headers: { 'Request-Id': 'req_h' } }),
    );
    const error = (await createOrbitTransport(client)
      .request('GET', '/v1/x')
      .catch((e: unknown) => e)) as OrbitApiError;
    expect(error.status).toBe(502);
    expect(error.type).toBe('api_error');
    expect(error.message).toBe('Request failed (HTTP 502)');
    expect(error.requestId).toBe('req_h');
  });

  it('a 401 in the envelope is the session state', async () => {
    const { client } = fakeClient(
      Response.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Authentication required',
            request_id: 'req_401',
          },
        },
        { status: 401 },
      ),
    );
    const error = (await createOrbitTransport(client)
      .request('GET', '/v1/x')
      .catch((e: unknown) => e)) as OrbitApiError;
    expect(error.type).toBe('authentication_error');
    expect(error.message).toBe('Authentication required');
    expect(errorState(error)).toEqual({ kind: 'session', requestId: 'req_401' });
  });

  it('maps the gateway answers a screen meets to the state it shows', async () => {
    const envelope = (status: number, error: Record<string, string>) =>
      fakeClient(Response.json({ error: { request_id: 'req_s', ...error } }, { status })).client;
    const stateOf = async (client: ReturnType<typeof envelope>) =>
      errorState(
        await createOrbitTransport(client)
          .request('GET', '/v1/dashboard/applications/app/payment_intents')
          .catch((e: unknown) => e),
      );
    expect(
      await stateOf(
        envelope(404, {
          type: 'invalid_request_error',
          code: 'merchant_missing',
          message: 'no merchant registered for this application in this environment',
        }),
      ),
    ).toEqual({ kind: 'merchant_missing' });
    expect(
      await stateOf(
        envelope(403, {
          type: 'permission_error',
          code: 'application_membership_required',
          message: 'you are not a member of this application',
        }),
      ),
    ).toEqual({
      kind: 'permission',
      permission: null,
      membership: true,
      readOnly: false,
      requestId: 'req_s',
    });
    expect(await stateOf(envelope(500, { type: 'api_error', message: 'internal error' }))).toEqual({
      kind: 'failure',
      reason: 'server',
      message: 'internal error',
      requestId: 'req_s',
    });
  });

  it('refuses a 2xx body that is not JSON instead of rendering garbage', async () => {
    const { client } = fakeClient(new Response('not json', { status: 200 }));
    await expect(createOrbitTransport(client).request('GET', '/v1/x')).rejects.toThrow('not JSON');
  });
});

describe('describeError', () => {
  it('uses a plain error message, then the fallback', () => {
    expect(describeError(new Error('offline'), 'fallback')).toBe('offline');
    expect(describeError('???', 'fallback')).toBe('fallback');
  });

  it('says where to fix a live merchant’s missing FairCoin key, not the gateway’s words', () => {
    const refused = new OrbitApiError({
      status: 409,
      type: 'invalid_request_error',
      code: 'faircoin_account_required',
      message: 'gateway words',
      requestId: 'req_9',
    });
    expect(describeError(refused, 'fallback')).toBe(
      'You cannot take payments until you register your FairCoin key. Register it once in Settings › FairCoin receiving key. (request req_9)',
    );
  });
});
