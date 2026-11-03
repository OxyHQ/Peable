import { describe, expect, test } from 'bun:test';
import { errorDocUrl } from '@peable.to/contracts/vocabulary';
import {
  errorFromResponse,
  PeableAPIError,
  PeableAuthenticationError,
  PeableCardError,
  PeableError,
  PeableIdempotencyError,
  PeableInvalidRequestError,
  PeablePermissionError,
  PeableRateLimitError,
} from '../../src/core/errors';

describe('errorFromResponse', () => {
  test('maps a nested Gateway envelope (sendError shape) using error.type/message', () => {
    const err = errorFromResponse(400, {
      error: {
        type: 'invalid_request_error',
        message: 'amount must be a base-unit integer string',
        request_id: 'req_1',
      },
    });
    expect(err).toBeInstanceOf(PeableInvalidRequestError);
    expect(err).toBeInstanceOf(PeableError);
    expect(err.message).toBe('amount must be a base-unit integer string');
    expect(err.type).toBe('invalid_request_error');
    expect(err.code).toBeUndefined();
    expect(err.statusCode).toBe(400);
    expect(err.param).toBeUndefined();
    expect(err.requestId).toBe('req_1');
  });

  test('exposes the offending param, the specific code and the request id', () => {
    const err = errorFromResponse(
      400,
      {
        error: {
          type: 'invalid_request_error',
          code: 'parameter_invalid',
          param: 'metadata[order_id]',
          message: 'too long',
          request_id: 'req_body',
        },
      },
      'req_header',
    );
    expect(err).toBeInstanceOf(PeableInvalidRequestError);
    expect(err.code).toBe('parameter_invalid');
    expect(err.param).toBe('metadata[order_id]');
    // The body's id wins; it is the same id as the header on a gateway answer.
    expect(err.requestId).toBe('req_body');
  });

  test('falls back to the Request-Id header when the body carries no request_id', () => {
    const nested = errorFromResponse(
      500,
      { error: { type: 'api_error', message: 'internal error', request_id: null } },
      'req_header',
    );
    expect(nested.requestId).toBe('req_header');
    const flat = errorFromResponse(
      401,
      { error: 'TOKEN_EXPIRED', message: 'Service token expired' },
      'req_flat',
    );
    expect(flat).toBeInstanceOf(PeableAuthenticationError);
    expect(flat.requestId).toBe('req_flat');
    expect(errorFromResponse(500, undefined).requestId).toBeUndefined();
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

  test('5xx nested envelope maps to PeableAPIError', () => {
    const err = errorFromResponse(500, {
      error: { type: 'api_error', message: 'internal error' },
    });
    expect(err).toBeInstanceOf(PeableAPIError);
  });

  test('502 (webhook-style api_error) maps to PeableAPIError', () => {
    const err = errorFromResponse(502, {
      error: { type: 'api_error', message: 'failed to resolve recipient — try again' },
    });
    expect(err).toBeInstanceOf(PeableAPIError);
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
    expect(err).toBeInstanceOf(PeableAPIError);
    expect(err.message).toBe('Peable request failed with status 500');
    expect(err.code).toBeUndefined();
  });

  test('PeableError subclasses are also instanceof Error', () => {
    const err = errorFromResponse(404, {
      error: { type: 'invalid_request_error', message: 'not found' },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PeableInvalidRequestError');
  });
});

describe('one class per error.type', () => {
  test('the gateway type picks the class, whatever the status', () => {
    const cases = [
      ['idempotency_error', 409, PeableIdempotencyError],
      ['idempotency_error', 400, PeableIdempotencyError],
      ['rate_limit_error', 429, PeableRateLimitError],
      ['card_error', 402, PeableCardError],
      ['api_error', 502, PeableAPIError],
      ['permission_error', 403, PeablePermissionError],
      ['authentication_error', 401, PeableAuthenticationError],
      ['invalid_request_error', 404, PeableInvalidRequestError],
    ] as const;
    for (const [type, status, ErrorClass] of cases) {
      const error = errorFromResponse(status, { error: { type, message: 'x', request_id: null } });
      expect(error).toBeInstanceOf(ErrorClass);
      expect(error.type).toBe(type);
      expect(error.statusCode).toBe(status);
    }
  });

  test('a flat 429 is a rate-limit error too', () => {
    expect(errorFromResponse(429, { error: 'RATE_LIMITED', message: 'slow down' })).toBeInstanceOf(
      PeableRateLimitError,
    );
  });

  test('carries decline code, doc url, request id and the raw body', () => {
    const body = {
      error: {
        type: 'card_error',
        code: 'expired_card',
        decline_code: 'expired_card',
        message: 'Your card has insufficient funds.',
        request_id: 'req_card',
      },
    };
    const error = errorFromResponse(402, body, 'req_header');
    expect(error).toMatchObject({
      name: 'PeableCardError',
      code: 'expired_card',
      declineCode: 'expired_card',
      requestId: 'req_card',
      raw: body,
    });
    // `expired_card` is a network's code Peable passes through, not one it documents.
    expect(error.docUrl).toBeUndefined();
  });

  test("a documented code gets its doc url; the body's own doc_url wins", () => {
    const documented = errorFromResponse(404, {
      error: { type: 'invalid_request_error', code: 'resource_missing', message: 'x' },
    });
    expect(documented.docUrl).toBe(errorDocUrl('resource_missing'));
    const explicit = errorFromResponse(404, {
      error: {
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: 'x',
        doc_url: 'https://docs.peable.to/errors#elsewhere',
      },
    });
    expect(explicit.docUrl).toBe('https://docs.peable.to/errors#elsewhere');
  });

  test('an unknown type falls back to the status', () => {
    expect(errorFromResponse(503, { error: { type: 'toString', message: 'x' } })).toBeInstanceOf(
      PeableAPIError,
    );
  });
});
