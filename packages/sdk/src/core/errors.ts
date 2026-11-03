// The `PeableError` hierarchy — every non-2xx Gateway/oxy-api response is
// mapped into one of these, never a bare `Error` or a raw `Response`.
import type { PaymentIntent } from '@peable.to/shared-types';

export type PeableErrorType =
  | 'authentication_error'
  | 'invalid_request_error'
  | 'card_error'
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
  /**
   * The offending request field in bracket notation (`metadata[order_id]`,
   * `line_items[0][price]`), when the gateway names one.
   */
  param?: string;
  /** The `Request-Id` of the failed response — what Peable support asks for. */
  requestId?: string;
}

export class PeableError extends Error {
  readonly type: PeableErrorType;
  readonly statusCode?: number;
  readonly code?: string;
  readonly param?: string;
  readonly requestId?: string;

  constructor(type: PeableErrorType, message: string, details: PeableErrorDetails = {}) {
    super(message);
    this.name = 'PeableError';
    this.type = type;
    this.statusCode = details.statusCode;
    this.code = details.code;
    this.param = details.param;
    this.requestId = details.requestId;
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

/**
 * A card was declined (402, ADR 0019). `paymentIntent` is the payment as the
 * decline left it — `requires_payment_method` with `last_payment_error` — so a
 * caller can offer another card on the SAME payment without a re-read.
 */
export class PeableCardError extends PeableError {
  readonly declineCode?: string;
  readonly paymentIntent?: PaymentIntent;

  constructor(
    message: string,
    details: PeableErrorDetails & { declineCode?: string; paymentIntent?: PaymentIntent } = {},
  ) {
    super('card_error', message, details);
    this.name = 'PeableCardError';
    if (details.declineCode !== undefined) this.declineCode = details.declineCode;
    if (details.paymentIntent !== undefined) this.paymentIntent = details.paymentIntent;
    Object.setPrototypeOf(this, PeableCardError.prototype);
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

/** ADR 0014 D1: `{ error: { type, code?, param?, message, request_id } }`. */
interface NestedGatewayErrorBody {
  error: {
    type: string;
    message: string;
    code?: string;
    decline_code?: string;
    param?: string;
    request_id?: string | null;
    payment_intent?: PaymentIntent;
  };
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
 *   `{ error: { type, code?, param?, message, request_id } }` (`lib/http.ts`'s
 *   `sendError`).
 * - `@oxy.so/core`'s Express auth middleware (`oxy.middleware.service()` /
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
 *
 * `requestId` is the body's `request_id` when it carries one, else the
 * `Request-Id` response header (which every gateway response has, including
 * the flat-envelope auth refusals).
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  headerRequestId?: string | null,
): PeableError {
  let upstreamCode: string | undefined;
  let param: string | undefined;
  let requestId = headerRequestId ?? undefined;
  let message = `Peable request failed with status ${status}`;

  if (isNestedGatewayErrorBody(body)) {
    // The specific reason when the gateway names one (`account_not_ready`),
    // else the broad `type`.
    upstreamCode = typeof body.error.code === 'string' ? body.error.code : body.error.type;
    if (typeof body.error.param === 'string') param = body.error.param;
    if (typeof body.error.request_id === 'string') requestId = body.error.request_id;
    message = body.error.message;
  } else if (isFlatGatewayErrorBody(body)) {
    upstreamCode = body.error;
    message = body.message || message;
  }

  const details: PeableErrorDetails = {
    statusCode: status,
    code: upstreamCode,
    ...(param === undefined ? {} : { param }),
    ...(requestId === undefined ? {} : { requestId }),
  };
  if (status === 402 && isNestedGatewayErrorBody(body) && body.error.type === 'card_error') {
    return new PeableCardError(message, {
      ...details,
      ...(typeof body.error.decline_code === 'string'
        ? { declineCode: body.error.decline_code }
        : {}),
      ...(body.error.payment_intent !== undefined
        ? { paymentIntent: body.error.payment_intent }
        : {}),
    });
  }
  if (status === 401) return new PeableAuthenticationError(message, details);
  if (status === 403) return new PeablePermissionError(message, details);
  if (status >= 400 && status < 500) return new PeableInvalidRequestError(message, details);
  return new PeableApiError(message, details);
}
