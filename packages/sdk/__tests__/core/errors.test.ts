import { describe, expect, test } from 'bun:test';
import {
  errorFromResponse,
  PeableApiError,
  PeableAuthenticationError,
  PeableError,
  PeableInvalidRequestError,
  PeablePermissionError,
} from '../../src/core/errors';

describe('errorFromResponse', () => {
  test('maps a nested Gateway envelope (sendError shape) using error.type/message', () => {
    const err = errorFromResponse(422, {
      error: { type: 'invalid_request_error', message: 'amount must be a base-unit integer string' },
    });
    expect(err).toBeInstanceOf(PeableInvalidRequestError);
    expect(err).toBeInstanceOf(PeableError);
    expect(err.message).toBe('amount must be a base-unit integer string');
    expect(err.type).toBe('invalid_request_error');
    expect(err.code).toBe('invalid_request_error');
    expect(err.statusCode).toBe(422);
  });

  test('401 nested envelope maps to PeableAuthenticationError', () => {
    const err = errorFromResponse(401, {
      error: { type: 'authentication_error', message: 'missing service app credentials' },
    });
    expect(err).toBeInstanceOf(PeableAuthenticationError);
  });

  test('403 nested envelope maps to PeablePermissionError', () => {
    const err = errorFromResponse(403, {
      error: { type: 'permission_error', message: 'invalid client_secret' },
    });
    expect(err).toBeInstanceOf(PeablePermissionError);
  });

  test('5xx nested envelope maps to PeableApiError', () => {
    const err = errorFromResponse(500, {
      error: { type: 'api_error', message: 'internal error' },
    });
    expect(err).toBeInstanceOf(PeableApiError);
  });

  test('502 (webhook-style api_error) maps to PeableApiError', () => {
    const err = errorFromResponse(502, {
      error: { type: 'api_error', message: 'failed to resolve recipient — try again' },
    });
    expect(err).toBeInstanceOf(PeableApiError);
  });

  // `@oxy.so/core`'s Express auth middleware (serviceAuth()/requireScope())
  // rejects a missing/expired/insufficiently-scoped service token with a
  // FLAT envelope, not the Gateway's own nested `sendError` shape. A caller
  // of this SDK hits this shape on the most common failure — an expired
  // service token — so it must classify correctly by status.
  test('flat envelope (requireScope 403 INSUFFICIENT_SCOPE) maps to PeablePermissionError', () => {
    const err = errorFromResponse(403, {
      error: 'INSUFFICIENT_SCOPE',
      message: "Required scope 'payments:write' not granted",
      code: 'INSUFFICIENT_SCOPE',
      status: 403,
    });
    expect(err).toBeInstanceOf(PeablePermissionError);
    expect(err.message).toBe("Required scope 'payments:write' not granted");
    expect(err.code).toBe('INSUFFICIENT_SCOPE');
  });

  test('flat envelope (serviceAuth 401 TOKEN_EXPIRED) maps to PeableAuthenticationError', () => {
    const err = errorFromResponse(401, {
      error: 'TOKEN_EXPIRED',
      message: 'Service token expired',
      code: 'TOKEN_EXPIRED',
      status: 401,
    });
    expect(err).toBeInstanceOf(PeableAuthenticationError);
    expect(err.code).toBe('TOKEN_EXPIRED');
  });

  test('flat envelope (oxy-api ApiError.toJSON) maps to PeableInvalidRequestError on 400', () => {
    const err = errorFromResponse(400, {
      error: 'BAD_REQUEST',
      message: 'apiKey and apiSecret are required',
    });
    expect(err).toBeInstanceOf(PeableInvalidRequestError);
  });

  test('an unparseable/empty body still maps by status with a generic message', () => {
    const err = errorFromResponse(500, undefined);
    expect(err).toBeInstanceOf(PeableApiError);
    expect(err.message).toBe('Peable request failed with status 500');
    expect(err.code).toBeUndefined();
  });

  test('PeableError subclasses are also instanceof Error', () => {
    const err = errorFromResponse(404, { error: { type: 'invalid_request_error', message: 'not found' } });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PeableInvalidRequestError');
  });
});
