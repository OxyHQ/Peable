import type { z } from 'zod';
import type { Expand } from './common/objects';

/**
 * One public route of the gateway, declared once (ADR 0014 D5).
 *
 * The backend validates its request with `query` / `body` (the SAME schema
 * objects, imported), its route tests check every answer against `response`,
 * the OpenAPI document is generated from the list of these, and the SDK's
 * methods are generated from `sdk` — so the four cannot disagree.
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'delete';

/**
 * Who may call it.
 *
 * - `service`: an Oxy service token (`Authorization: Bearer …`) the merchant's
 *   server mints from its application credential — the merchant API;
 * - `user`: an Oxy user session (`Authorization: Bearer …`) — the person, in
 *   the Peable app or an Oxy app (social payments, contributions, onboarding);
 * - `public`: no credential. A payer-facing route, authorised by the
 *   unguessable id or client secret it is called with.
 */
export type RouteAuth = 'service' | 'user' | 'public';

/** A non-JSON success: bytes (a PDF, a CSV, a file's contents). */
export interface BinaryResponse {
  readonly kind: 'binary';
  readonly contentType: string;
}

/** A Server-Sent Events stream (a live tail). */
export interface StreamResponse {
  readonly kind: 'stream';
  /** The schema of each event's `data`. */
  readonly event: z.ZodType;
}

export type RouteResponse = z.ZodType | BinaryResponse | StreamResponse;

export interface RouteContract {
  /** Unique, camelCase: `createCustomer`. */
  readonly operationId: string;
  readonly method: HttpMethod;
  /** OpenAPI template: `/v1/customers/{id}`. */
  readonly path: string;
  /** The reference section it is listed under: `Customers`. */
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  readonly auth: RouteAuth;
  /** The Oxy scope a `service` route requires. */
  readonly scope?: string;
  /** Path parameters, in path order. Each is a string; documented here. */
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  /** `multipart` for a file upload; JSON otherwise. */
  readonly bodyEncoding?: 'json' | 'multipart';
  /** Accepts `Idempotency-Key` (every merchant `POST` but the few ADR 0014 D3 names). */
  readonly idempotent?: boolean;
  /** Accepts `Peable-Account: ca_…` (a platform acting on a connected account). */
  readonly peableAccount?: boolean;
  /** Answers only in test mode. */
  readonly testModeOnly?: boolean;
  readonly response: RouteResponse;
  /** The success status. Default 200. */
  readonly status?: 200 | 201 | 202 | 204;
  /**
   * The SDK method, as a dotted path from the client: `customers.create`,
   * `billing.meters.listEventSummaries`. Absent: not exposed by the server SDK
   * (a payer route the browser entry owns, a route an Oxy app calls with a
   * user session).
   */
  readonly sdk?: string;
  /** The object type `expand[]` paths are rooted at (`x-peable-expandable`). */
  readonly expandable?: string;
}

/** Declare a route, keeping its literal types for the SDK's inference. */
export function defineRoute<const R extends RouteContract>(route: R): R {
  return route;
}

/** The parameters a route's body accepts (its wire input). */
export type BodyOf<R extends RouteContract> = R['body'] extends z.ZodType
  ? z.input<R['body']>
  : never;

/** The parameters a route's query accepts (its wire input). */
export type QueryOf<R extends RouteContract> = R['query'] extends z.ZodType
  ? z.input<R['query']>
  : never;

/** What a route answers with on success, references resolved. */
export type ResponseOf<R extends RouteContract> = R['response'] extends z.ZodType
  ? Expand<z.output<R['response']>>
  : R['response'] extends BinaryResponse
    ? Uint8Array
    : R['response'] extends StreamResponse
      ? Expand<z.output<R['response']['event']>>
      : never;

/** `/v1/customers/{id}` → `/v1/customers/:id`, Express's spelling. */
export function expressPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/** The path parameter names of a template, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
}

/** Whether `response` is a JSON schema (as opposed to bytes or a stream). */
export function isJsonResponse(response: RouteResponse): response is z.ZodType {
  return '_zod' in response;
}
