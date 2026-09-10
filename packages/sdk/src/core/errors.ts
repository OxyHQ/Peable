// The `PeableError` hierarchy — every non-2xx Gateway/oxy-api response is
// mapped into one of these, never a bare `Error` or a raw `Response`.

export type PeableErrorType =
  | 'authentication_error'
  | 'invalid_request_error'
  | 'permission_error'
  | 'api_error'
  | 'signature_verification_error';

export interface PeableErrorDetails {
  /** The HTTP status code that produced this error, when applicable. */
  statusCode?: number;
  /**
   * The raw upstream discriminator: `error.type` from the Gateway's own
   * `{ error: { type, message } }` envelope, or the flat `error` code string
   * from `@oxy.so/core`'s auth middleware (`{ error: 'INVALID_TOKEN', ... }`)
   * — see `errorFromResponse`'s doc comment for why both shapes exist.
   */
  code?: string;
}

export class PeableError extends Error {
  readonly type: PeableErrorType;
  readonly statusCode?: number;
  readonly code?: string;

  constructor(type: PeableErrorType, message: string, details: PeableErrorDetails = {}) {
    super(message);
    this.name = 'PeableError';
    this.type = type;
    this.statusCode = details.statusCode;
    this.code = details.code;
    Object.setPrototypeOf(this, PeableError.prototype);
  }
}

export class PeableAuthenticationError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('authentication_error', message, details);
    this.name = 'PeableAuthenticationError';
    Object.setPrototypeOf(this, PeableAuthenticationError.prototype);
  }
}

export class PeableInvalidRequestError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('invalid_request_error', message, details);
    this.name = 'PeableInvalidRequestError';
    Object.setPrototypeOf(this, PeableInvalidRequestError.prototype);
  }
}

export class PeablePermissionError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('permission_error', message, details);
    this.name = 'PeablePermissionError';
    Object.setPrototypeOf(this, PeablePermissionError.prototype);
  }
}

export class PeableApiError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('api_error', message, details);
    this.name = 'PeableApiError';
    Object.setPrototypeOf(this, PeableApiError.prototype);
  }
}

/** Thrown by `webhooks.constructEvent` on a bad/stale/tampered signature. */
export class PeableSignatureVerificationError extends PeableError {
  constructor(message: string) {
    super('signature_verification_error', message);
    this.name = 'PeableSignatureVerificationError';
    Object.setPrototypeOf(this, PeableSignatureVerificationError.prototype);
  }
}

interface NestedGatewayErrorBody {
  error: { type: string; message: string };
}

interface FlatGatewayErrorBody {
  error: string;
  message: string;
  code?: string;
}

function isNestedGatewayErrorBody(body: unknown): body is NestedGatewayErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const { error } = body as { error: unknown };
  if (typeof error !== 'object' || error === null) return false;
  const nested = error as { type?: unknown; message?: unknown };
  return typeof nested.type === 'string' && typeof nested.message === 'string';
}

function isFlatGatewayErrorBody(body: unknown): body is FlatGatewayErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const { error } = body as { error: unknown };
  return typeof error === 'string';
}

/**
 * Map an HTTP status + parsed JSON body into a typed `PeableError`.
 *
 * The Oxy ecosystem returns TWO distinct error envelopes depending on WHERE a
 * request was rejected:
 * - The Gateway's own route handlers use the Stripe-style nested envelope
 *   `{ error: { type, message } }` (`lib/http.ts`'s `sendError`).
 * - `@oxy.so/core`'s Express auth middleware (`oxyClient.serviceAuth()` /
 *   `requireScope()` — rejecting a missing/expired/insufficiently-scoped
 *   service token BEFORE a route handler ever runs) and oxy-api's own
 *   `ApiError.toJSON()` use a FLAT envelope: `{ error: <CODE_STRING>,
 *   message, code? }`.
 *
 * A caller of this SDK hits the flat shape on every auth failure (expired
 * token, missing scope, bad credentials at mint time), so the HTTP status
 * code — not `error.type` — is the primary classifier here; the raw
 * upstream `type`/`code` string is still attached to the resulting error
 * (`.code`) for callers who want it.
 */
export function errorFromResponse(status: number, body: unknown): PeableError {
  let upstreamCode: string | undefined;
  let message = `Peable request failed with status ${status}`;

  if (isNestedGatewayErrorBody(body)) {
    upstreamCode = body.error.type;
    message = body.error.message;
  } else if (isFlatGatewayErrorBody(body)) {
    upstreamCode = body.error;
    message = body.message || message;
  }

  const details: PeableErrorDetails = { statusCode: status, code: upstreamCode };
  if (status === 401) return new PeableAuthenticationError(message, details);
  if (status === 403) return new PeablePermissionError(message, details);
  if (status >= 400 && status < 500) return new PeableInvalidRequestError(message, details);
  return new PeableApiError(message, details);
}
