// The `PeableError` hierarchy — every failure a request can end in is one of
// these, never a bare `Error` or a raw `Response`: one class per gateway
// `error.type` (ADR 0014 D1), plus the two the SDK itself raises — a
// connection that never produced an answer, and a webhook that does not verify.
//
// Imported by the browser entries (`./checkout`, `./checkout/ui`) too, so it
// must stay free of Node built-ins and of anything that constructs a schema,
// and it imports the ONE vocabulary module it reads: an app bundler that does
// not tree-shake (Metro) bundles every module of the `vocabulary` barrel
// (`scripts/browser-entries.test.ts`).

import { ERROR_CODES, type ErrorType, errorDocUrl } from '@peable.to/contracts/vocabulary/errors';
import type { PaymentIntent } from '@peable.to/shared-types';

/**
 * `error.type`: the gateway's seven, `api_connection_error` for a request that
 * got no answer, and `signature_verification_error` for a webhook delivery.
 */
export type PeableErrorType = ErrorType | 'api_connection_error' | 'signature_verification_error';

export interface PeableErrorDetails {
  /** The HTTP status, when an answer was read. */
  statusCode?: number;
  /**
   * The machine-readable reason: the gateway's `error.code`
   * (`resource_missing`, `parameter_invalid`, a card network's decline code),
   * or the flat code of an Oxy auth refusal (`INVALID_TOKEN`), or one the SDK
   * names itself (`invalid_response`, `timeout`).
   */
  code?: string;
  /** A card issuer's decline reason, on a `card_error`. */
  declineCode?: string;
  /** The offending request field, in bracket notation (`metadata[order_id]`). */
  param?: string;
  /** Where `code` is documented. */
  docUrl?: string;
  /** The `Request-Id` of the failed response — what Peable support asks for. */
  requestId?: string;
  /** The parsed response body, or the underlying failure of a connection error. */
  raw?: unknown;
}

export class PeableError extends Error {
  readonly type: PeableErrorType;
  readonly statusCode?: number;
  readonly code?: string;
  readonly declineCode?: string;
  readonly param?: string;
  readonly docUrl?: string;
  readonly requestId?: string;
  readonly raw?: unknown;

  constructor(type: PeableErrorType, message: string, details: PeableErrorDetails = {}) {
    super(message);
    this.name = 'PeableError';
    this.type = type;
    if (details.statusCode !== undefined) this.statusCode = details.statusCode;
    if (details.code !== undefined) this.code = details.code;
    if (details.declineCode !== undefined) this.declineCode = details.declineCode;
    if (details.param !== undefined) this.param = details.param;
    if (details.docUrl !== undefined) this.docUrl = details.docUrl;
    if (details.requestId !== undefined) this.requestId = details.requestId;
    if (details.raw !== undefined) this.raw = details.raw;
    Object.setPrototypeOf(this, PeableError.prototype);
  }
}

/** The request is malformed, names something that does not exist, or conflicts with an object (400, 404, 409). */
export class PeableInvalidRequestError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('invalid_request_error', message, details);
    this.name = 'PeableInvalidRequestError';
    Object.setPrototypeOf(this, PeableInvalidRequestError.prototype);
  }
}

/** The credential is missing, expired or invalid (401). */
export class PeableAuthenticationError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('authentication_error', message, details);
    this.name = 'PeableAuthenticationError';
    Object.setPrototypeOf(this, PeableAuthenticationError.prototype);
  }
}

/** The credential is valid but may not do this (403). */
export class PeablePermissionError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('permission_error', message, details);
    this.name = 'PeablePermissionError';
    Object.setPrototypeOf(this, PeablePermissionError.prototype);
  }
}

/**
 * A card was declined (402, ADR 0019). `paymentIntent` is the payment as the
 * decline left it — `requires_payment_method` with `last_payment_error` — so a
 * caller can offer another card on the SAME payment without a re-read.
 */
export class PeableCardError extends PeableError {
  readonly paymentIntent?: PaymentIntent;

  constructor(
    message: string,
    details: PeableErrorDetails & { paymentIntent?: PaymentIntent } = {},
  ) {
    super('card_error', message, details);
    this.name = 'PeableCardError';
    if (details.paymentIntent !== undefined) this.paymentIntent = details.paymentIntent;
    Object.setPrototypeOf(this, PeableCardError.prototype);
  }
}

/**
 * The `Idempotency-Key` was reused with a different request (400), or the
 * first request with it is still running (409 — retried automatically).
 */
export class PeableIdempotencyError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('idempotency_error', message, details);
    this.name = 'PeableIdempotencyError';
    Object.setPrototypeOf(this, PeableIdempotencyError.prototype);
  }
}

/** Too many requests (429 — retried automatically, honouring `Retry-After`). */
export class PeableRateLimitError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('rate_limit_error', message, details);
    this.name = 'PeableRateLimitError';
    Object.setPrototypeOf(this, PeableRateLimitError.prototype);
  }
}

/**
 * Something went wrong on Peable or its provider (5xx — retried
 * automatically), or the answer could not be trusted (`code: 'invalid_response'`).
 */
export class PeableAPIError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('api_error', message, details);
    this.name = 'PeableAPIError';
    Object.setPrototypeOf(this, PeableAPIError.prototype);
  }
}

/**
 * No answer was read: the network failed, the request timed out
 * (`code: 'timeout'`), or the connection dropped mid-body. Retried
 * automatically; a `POST` is retried under the SAME `Idempotency-Key`, so it
 * never runs twice.
 */
export class PeableConnectionError extends PeableError {
  constructor(message: string, details: PeableErrorDetails = {}) {
    super('api_connection_error', message, details);
    this.name = 'PeableConnectionError';
    Object.setPrototypeOf(this, PeableConnectionError.prototype);
  }
}

/** Thrown by `webhooks.constructEvent` on a bad, stale or tampered signature. */
export class PeableSignatureVerificationError extends PeableError {
  constructor(message: string) {
    super('signature_verification_error', message);
    this.name = 'PeableSignatureVerificationError';
    Object.setPrototypeOf(this, PeableSignatureVerificationError.prototype);
  }
}

/** ADR 0014 D1: `{ error: { type, code?, decline_code?, param?, message, doc_url?, request_id } }`. */
interface NestedErrorBody {
  error: {
    type: string;
    message: string;
    code?: unknown;
    decline_code?: unknown;
    param?: unknown;
    doc_url?: unknown;
    request_id?: unknown;
    payment_intent?: PaymentIntent;
  };
}

/** `@oxy.so/core`'s auth middleware and oxy-api: `{ error: 'INVALID_TOKEN', message }`. */
interface FlatErrorBody {
  error: string;
  message?: unknown;
}

function isNestedErrorBody(body: unknown): body is NestedErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const { error } = body as { error: unknown };
  if (typeof error !== 'object' || error === null) return false;
  const nested = error as { type?: unknown; message?: unknown };
  return typeof nested.type === 'string' && typeof nested.message === 'string';
}

function isFlatErrorBody(body: unknown): body is FlatErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  return typeof (body as { error: unknown }).error === 'string';
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const DOCUMENTED_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

type ErrorClass = new (message: string, details: PeableErrorDetails) => PeableError;

const CLASS_OF_TYPE_RECORD: Readonly<Record<ErrorType, ErrorClass>> = {
  api_error: PeableAPIError,
  authentication_error: PeableAuthenticationError,
  card_error: PeableCardError,
  idempotency_error: PeableIdempotencyError,
  invalid_request_error: PeableInvalidRequestError,
  permission_error: PeablePermissionError,
  rate_limit_error: PeableRateLimitError,
};
// A Map, so a `type` the body names is looked up among own entries only.
const CLASS_OF_TYPE: ReadonlyMap<string, ErrorClass> = new Map(
  Object.entries(CLASS_OF_TYPE_RECORD),
);

/** The class of an answer whose body names no gateway `error.type`. */
function classOfStatus(status: number): ErrorClass {
  if (status === 401) return PeableAuthenticationError;
  if (status === 403) return PeablePermissionError;
  if (status === 429) return PeableRateLimitError;
  if (status >= 400 && status < 500) return PeableInvalidRequestError;
  return PeableAPIError;
}

/**
 * Map an HTTP status and its parsed body into the typed error.
 *
 * Two envelopes reach a caller. The gateway's own handlers answer the nested
 * ADR 0014 envelope, whose `type` picks the class. `@oxy.so/core`'s auth
 * middleware — which refuses a missing, expired or under-scoped service token
 * BEFORE any handler runs — and oxy-api's token mint answer a flat
 * `{ error: 'CODE', message }`, so for those (and for a body that is not JSON
 * at all) the status picks the class and the flat code is `code`.
 *
 * `requestId` is the body's `request_id`, else the `Request-Id` header (which
 * every gateway response carries, the flat auth refusals included). `docUrl`
 * is the body's `doc_url`, else the documentation of a code Peable documents.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  headerRequestId?: string | null,
): PeableError {
  const fallbackMessage = `Peable request failed with status ${status}`;
  const headerId = headerRequestId ?? undefined;
  if (isNestedErrorBody(body)) {
    const { error } = body;
    const code = stringOf(error.code);
    const docUrl =
      stringOf(error.doc_url) ??
      (code !== undefined && DOCUMENTED_CODES.has(code) ? errorDocUrl(code) : undefined);
    const details: PeableErrorDetails = {
      statusCode: status,
      raw: body,
      ...(code === undefined ? {} : { code }),
      ...(stringOf(error.decline_code) === undefined
        ? {}
        : { declineCode: stringOf(error.decline_code) }),
      ...(stringOf(error.param) === undefined ? {} : { param: stringOf(error.param) }),
      ...(docUrl === undefined ? {} : { docUrl }),
      ...((stringOf(error.request_id) ?? headerId) === undefined
        ? {}
        : { requestId: stringOf(error.request_id) ?? headerId }),
    };
    const message = error.message || fallbackMessage;
    if (error.type === 'card_error') {
      return new PeableCardError(message, {
        ...details,
        ...(error.payment_intent === undefined ? {} : { paymentIntent: error.payment_intent }),
      });
    }
    const ErrorClass = CLASS_OF_TYPE.get(error.type) ?? classOfStatus(status);
    return new ErrorClass(message, details);
  }
  const flat = isFlatErrorBody(body) ? body : undefined;
  const ErrorClass = classOfStatus(status);
  return new ErrorClass(stringOf(flat?.message) ?? fallbackMessage, {
    statusCode: status,
    ...(body === undefined ? {} : { raw: body }),
    ...(flat === undefined ? {} : { code: flat.error }),
    ...(headerId === undefined ? {} : { requestId: headerId }),
  });
}
