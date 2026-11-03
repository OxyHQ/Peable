import type { Request, Response } from 'express';
import { z } from 'zod';
import { OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
import type { CreatedRange, KeysetPage } from '../db/keyset';
import { type ExpandableType, expandObjects, parseExpand } from './expand';
import { sendError, sendValidationError } from './http';

/**
 * The route half of every list (ADR 0014 D1):
 *
 * - query: `limit` (1–100, default 10), `starting_after` | `ending_before`
 *   (public ids, mutually exclusive), `created` / `created[gt|gte|lt|lte]`
 *   (Unix seconds), `expand[]` (`data.`-prefixed paths);
 * - response: `{ object: 'list', data, has_more, url }`, `url` being the path
 *   that was listed.
 *
 * The repository half is `db/keyset.ts`. Every list endpoint goes through
 * `answerList`, so a list cannot exist that pages differently from its
 * siblings — the drift this replaced had three envelopes and four limits.
 */

export const LIST_LIMIT_DEFAULT = 10;
export const LIST_LIMIT_MAX = 100;

const unixSeconds = z.coerce.number().int().nonnegative();

/**
 * `created=X` (exactly that second) or `created[op]=X`. The bare form is
 * normalized to the range `[X, X]` so the repository has one shape to read.
 */
const createdParam = z.union([
  unixSeconds.transform((x): CreatedRange => ({ gte: x, lte: x })),
  z
    .object({
      gt: unixSeconds.optional(),
      gte: unixSeconds.optional(),
      lt: unixSeconds.optional(),
      lte: unixSeconds.optional(),
    })
    .strict()
    .transform((range): CreatedRange => range),
]);

/**
 * `expand[]=a&expand[]=b` arrives as an array; `expand=a` as a string. Both
 * mean the same request, so both are accepted.
 */
export const expandParam = z.preprocess(
  (value) => (typeof value === 'string' ? [value] : value),
  z.array(z.string().min(1).max(200)).max(20),
);

/** The public id of a cursor. Bounded so a cursor is never an unbounded index probe. */
const cursorParam = z.string().min(1).max(255);

const listShape = {
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
  starting_after: cursorParam.optional(),
  ending_before: cursorParam.optional(),
  created: createdParam.optional(),
  expand: expandParam.optional(),
};

/**
 * A list query: the shared parameters plus the route's own filters.
 *
 * `.strict()`: an unknown parameter is a 400 naming it, never silently ignored
 * — `?stauts=settled` answering every intent is a filter the caller believes
 * they applied.
 */
export function listQuerySchema<S extends z.ZodRawShape>(filters: S) {
  return z
    .object({ ...listShape, ...filters })
    .strict()
    .superRefine((query, ctx) => {
      if (query.starting_after !== undefined && query.ending_before !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ending_before'],
          message: 'starting_after and ending_before are mutually exclusive',
        });
      }
    });
}

/** A retrieve's query: `expand[]` and nothing else unless the route says so. */
export function retrieveQuerySchema<S extends z.ZodRawShape>(extra: S) {
  return z.object({ expand: expandParam.optional(), ...extra }).strict();
}

/**
 * Which route family a shared handler core answers for. A dashboard request
 * (`/v1/dashboard/applications/:applicationId/…`) carries `environment` beside
 * the list parameters — its Test/Live toggle, validated by the dashboard's
 * access gate — which the strict service-authed schema would refuse.
 */
export type QuerySurface = 'api' | 'dashboard';

const dashboardQueryScope = { environment: z.enum(OXY_SERVICE_ENVIRONMENTS) } as const;

/** One list schema per surface, for a core shared by the API and the dashboard. */
export function surfaceListQuery<S extends z.ZodRawShape>(filters: S) {
  return {
    api: listQuerySchema(filters),
    dashboard: listQuerySchema({ ...filters, ...dashboardQueryScope }),
  } as const;
}

/** One retrieve schema per surface. */
export function surfaceRetrieveQuery() {
  return {
    api: retrieveQuerySchema({}),
    dashboard: retrieveQuerySchema(dashboardQueryScope),
  } as const;
}

export interface ListQuery {
  readonly limit: number;
  readonly starting_after?: string | undefined;
  readonly ending_before?: string | undefined;
  readonly created?: CreatedRange | undefined;
  readonly expand?: readonly string[] | undefined;
}

/** Parse a query with `schema`, or answer the 400 and return `null`. */
export function parseQuery<T>(
  req: Request,
  res: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T | null {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return null;
  }
  return parsed.data;
}

/** The path that was listed — the list's `url`, without its query string. */
export function listUrl(req: Request): string {
  return req.originalUrl.split('?')[0] ?? req.path;
}

/**
 * Resolve a query parameter naming an object — a cursor, or a filter such as
 * `payment_intent=pi_…` — from its PUBLIC id to the internal key the query
 * runs on.
 *
 * The resolver is the caller's own scoped lookup, so a parameter naming another
 * merchant's object is the same 400 as one naming nothing: neither confirms
 * that the object exists. 400 and not 404 or 422 — the RESOURCE being listed
 * exists; the parameter is what is wrong, and `param` says which.
 *
 * Writes the answer and returns `{ ok: false }` when it does not resolve.
 */
export async function resolveListReference(
  res: Response,
  param: string,
  publicId: string | undefined,
  resolve: (publicId: string) => Promise<string | null>,
): Promise<{ ok: true; id: string | undefined } | { ok: false }> {
  if (publicId === undefined) return { ok: true, id: undefined };
  const id = await resolve(publicId);
  if (id === null) {
    sendError(
      res,
      400,
      'invalid_request_error',
      `${param} does not name an object this caller can read`,
      'resource_missing',
      param,
    );
    return { ok: false };
  }
  return { ok: true, id };
}

export interface AnswerListArgs<Row> {
  readonly query: ListQuery;
  /** The object type of `data[]` — what `expand[]=data.…` is validated against. */
  readonly type: ExpandableType;
  /** The scope expansions resolve in. Always the caller's merchant. */
  readonly merchantId: string;
  /** Public id → internal primary key, inside the caller's scope AND this list's filter. */
  readonly cursor: (publicId: string) => Promise<string | null>;
  readonly fetch: (page: KeysetPage) => Promise<{ data: readonly Row[]; hasMore: boolean }>;
  /** One row to its wire object — or {@link serializeAll}, for rows rendered in a batch. */
  readonly serialize?: (row: Row) => object | Promise<object>;
  /** All the page's rows at once (one read per related kind, not per row). */
  readonly serializeAll?: (rows: readonly Row[]) => Promise<object[]>;
  /** Fields a specific list carries beside the envelope (`remaining_refundable`). */
  readonly extra?: Record<string, unknown>;
}

/**
 * Answer one list request end to end.
 *
 * The order is deliberate: the expansion is validated BEFORE any cursor is
 * resolved or any row read, so a malformed request costs no query and its
 * answer never depends on what exists.
 */
export async function answerList<Row>(
  req: Request,
  res: Response,
  args: AnswerListArgs<Row>,
): Promise<void> {
  const tree = parseExpand(res, args.type, args.query.expand, { list: true });
  if (tree === null) return;

  const after = await resolveListReference(
    res,
    'starting_after',
    args.query.starting_after,
    args.cursor,
  );
  if (!after.ok) return;
  const before = await resolveListReference(
    res,
    'ending_before',
    args.query.ending_before,
    args.cursor,
  );
  if (!before.ok) return;

  const page = await args.fetch({
    limit: args.query.limit,
    after: after.id,
    before: before.id,
    created: args.query.created,
  });
  const data = args.serializeAll
    ? await args.serializeAll(page.data)
    : await Promise.all(
        page.data.map((row) => {
          if (!args.serialize) throw new Error('a list needs serialize or serializeAll');
          return args.serialize(row);
        }),
      );
  await expandObjects(data, args.type, tree, args.merchantId);
  res.status(200).json({
    object: 'list',
    data,
    has_more: page.hasMore,
    url: listUrl(req),
    ...args.extra,
  });
}

/**
 * The envelope for a list that is a COMPLETE, bounded set rather than a
 * collection that grows with use: the tax-code catalog, a merchant's tax
 * registrations and product codes. The same shape as every other list, with
 * `has_more: false` stated rather than implied — a caller written against the
 * paged lists reads it unchanged.
 */
export function completeList<T>(req: Request, data: readonly T[]) {
  return { object: 'list' as const, data, has_more: false, url: listUrl(req) };
}
