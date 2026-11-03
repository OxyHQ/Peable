import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
import {
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_SUBSTRING_MIN_LENGTH,
  SEARCHABLE_RESOURCES,
  type SearchableResource,
} from '@peable.to/shared-types';
import { getDb } from '../../db/postgres';
import { expandObjects, parseExpand } from '../expand';
import { sendError } from '../http';
import { expandParam, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, listUrl, parseQuery } from '../list';
import type { QuerySurface } from '../list';
import { compileSearch } from './compile';
import { decodeSearchPage, encodeSearchPage } from './page';
import { parseSearchQuery, type SearchClause, type SearchQuery, SearchQueryError } from './parser';
import { SEARCH_RESOURCES, type SearchResource } from './resources';

/**
 * The route half of every search (Stripe's Search API):
 *
 * - query: `query` (required), `limit` (1–100, default 10), `page` (the
 *   previous answer's `next_page`), `expand[]` (`data.`-prefixed, plus
 *   `total_count`);
 * - response: `{ object: 'search_result', data, has_more, next_page, url,
 *   total_count? }`.
 *
 * The order of work is `answerList`'s, for its reason: everything that can be
 * refused — the parameters, the expansion, the query, the page token — is
 * refused before any row is read, so a malformed search costs no query and its
 * answer never depends on what exists.
 */

const TOTAL_COUNT = 'total_count';

const searchShape = {
  query: z
    .string({ required_error: 'query is required' })
    .min(1, 'query is required')
    .max(
      SEARCH_QUERY_MAX_LENGTH,
      `a query is at most ${String(SEARCH_QUERY_MAX_LENGTH)} characters`,
    ),
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
  page: z.string().min(1).max(512).optional(),
  expand: expandParam.optional(),
};

/** Strict, as every list: an unknown parameter is a 400 naming it. */
export const searchQuerySchema = {
  api: z.object(searchShape).strict(),
  dashboard: z.object({ ...searchShape, environment: z.enum(OXY_SERVICE_ENVIRONMENTS) }).strict(),
} as const;

/** A refusal of the query, answered as Stripe does: 400 naming `query`. */
function sendQueryError(res: Response, error: SearchQueryError): void {
  sendError(res, 400, 'invalid_request_error', error.message, 'parameter_invalid', 'query');
}

/** Parse and compile, or answer the 400 and return `null`. */
function compileOrRefuse(
  res: Response,
  resource: SearchResource,
  query: SearchQuery | string,
  merchantId: string,
) {
  try {
    const parsed = typeof query === 'string' ? parseSearchQuery(query) : query;
    return compileSearch(parsed, resource.fields, { merchantId, resource: resource.name });
  } catch (error) {
    if (error instanceof SearchQueryError) {
      sendQueryError(res, error);
      return null;
    }
    throw error;
  }
}

/** Answer one `GET /v1/<resource>/search` end to end. */
export async function answerSearch(
  req: Request,
  res: Response,
  merchantId: string,
  resource: SearchResource,
  surface: QuerySurface,
): Promise<void> {
  const params = parseQuery(req, res, searchQuerySchema[surface]);
  if (!params) return;
  const requested = params.expand ?? [];
  const countWanted = requested.includes(TOTAL_COUNT);
  const tree = parseExpand(
    res,
    resource.object,
    requested.filter((path) => path !== TOTAL_COUNT),
    { list: true },
  );
  if (tree === null) return;
  const search = compileOrRefuse(res, resource, params.query, merchantId);
  if (search === null) return;
  let after: string | undefined;
  if (params.page !== undefined) {
    const decoded = decodeSearchPage(resource.name, params.query, params.page);
    if (!decoded.ok) {
      sendError(res, 400, 'invalid_request_error', decoded.message, 'parameter_invalid', 'page');
      return;
    }
    after = decoded.after;
  }

  const db = getDb();
  const page = await resource.run(db, {
    merchantId,
    search,
    page: { limit: params.limit, after },
  });
  const data = page.data.map((hit) => hit.object);
  await expandObjects(data, resource.object, tree, merchantId);
  const last = page.data.at(-1);
  res.status(200).json({
    object: 'search_result',
    data,
    has_more: page.hasMore,
    next_page:
      page.hasMore && last !== undefined
        ? encodeSearchPage(resource.name, params.query, last.key)
        : null,
    url: listUrl(req),
    ...(countWanted ? { total_count: await resource.count(db, { merchantId, search }) } : {}),
  });
}

// ---------------------------------------------------------------------------
// Orbit's global search box
// ---------------------------------------------------------------------------

/** How many hits of each resource the global box shows. */
const GLOBAL_LIMIT = 5;

const globalQuerySchema = z
  .object({
    q: z.string().trim().min(1, 'q is required').max(SEARCH_QUERY_MAX_LENGTH),
    environment: z.enum(OXY_SERVICE_ENVIRONMENTS),
  })
  .strict();

/** `pi_…`, `cus_…`: an id is looked up, not searched for. */
const PUBLIC_ID = /^([a-z]+)_[A-Za-z0-9-]+$/;

/**
 * The free-text query a term means on one resource: each of its `textFields`
 * — a substring where the field takes one and the term is long enough, an
 * exact match otherwise — OR-ed. Built as a parsed query, never as text, so the
 * term needs no quoting and cannot change the query's shape.
 */
function freeTextQuery(resource: SearchResource, term: string): SearchQuery | null {
  const clauses: SearchClause[] = [];
  for (const name of resource.textFields) {
    const field = resource.fields[name];
    if (field?.type !== 'string') continue;
    const substring = field.substring !== false && term.length >= SEARCH_SUBSTRING_MIN_LENGTH;
    if (!substring && field.substring !== false) continue;
    clauses.push({
      field: name,
      negated: false,
      operator: substring ? '~' : ':',
      value: { kind: 'string', value: term },
      position: 0,
      valuePosition: 0,
    });
  }
  return clauses.length === 0 ? null : { combinator: 'or', clauses };
}

/** Whether `q` is written in the query language (`email:"…"`), rather than free text. */
function asStructured(q: string): SearchQuery | null {
  try {
    return parseSearchQuery(q);
  } catch {
    return null;
  }
}

/**
 * `GET /v1/dashboard/applications/:id/search?q=…` — Orbit's one box over every
 * searchable resource, at most five hits each.
 *
 * - an id (`pi_…`, `cus_…`) is that object, on the resource its prefix names;
 * - a query in the search language runs on every resource that has all of its
 *   fields (a query no resource can answer is the first resource's 400);
 * - anything else is free text, matched against each resource's `textFields`.
 *
 * Every branch compiles through the same compiler and walks the same list
 * functions as the API, inside the member's merchant.
 */
export async function answerGlobalSearch(
  req: Request,
  res: Response,
  merchantId: string,
): Promise<void> {
  const parsed = globalQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    sendError(
      res,
      400,
      'invalid_request_error',
      issue?.message ?? 'invalid request',
      'parameter_invalid',
      issue?.path[0] === undefined ? 'q' : String(issue.path[0]),
    );
    return;
  }
  const { q } = parsed.data;
  const db = getDb();
  const plans: { resource: SearchResource; search: ReturnType<typeof compileSearch> }[] = [];
  let mode: 'id' | 'query' | 'text';

  const id = PUBLIC_ID.exec(q);
  const byPrefix = id
    ? SEARCHABLE_RESOURCES.map((name) => SEARCH_RESOURCES[name]).find(
        (resource) => resource.idPrefix === id[1],
      )
    : undefined;
  const structured = byPrefix === undefined ? asStructured(q) : null;
  if (byPrefix !== undefined) {
    mode = 'id';
    plans.push({ resource: byPrefix, search: sql`${byPrefix.publicId} = ${q}::text` });
  } else if (structured !== null) {
    mode = 'query';
    let firstError: SearchQueryError | null = null;
    for (const name of SEARCHABLE_RESOURCES) {
      const resource = SEARCH_RESOURCES[name];
      try {
        plans.push({
          resource,
          search: compileSearch(structured, resource.fields, { merchantId, resource: name }),
        });
      } catch (error) {
        if (!(error instanceof SearchQueryError)) throw error;
        firstError ??= error;
      }
    }
    if (plans.length === 0 && firstError !== null) {
      sendQueryError(res, firstError);
      return;
    }
  } else {
    mode = 'text';
    for (const name of SEARCHABLE_RESOURCES) {
      const resource = SEARCH_RESOURCES[name];
      const query = freeTextQuery(resource, q);
      if (query === null) continue;
      plans.push({
        resource,
        search: compileSearch(query, resource.fields, { merchantId, resource: name }),
      });
    }
  }

  const groups = await Promise.all(
    plans.map(async ({ resource, search }) => {
      const page = await resource.run(db, { merchantId, search, page: { limit: GLOBAL_LIMIT } });
      return {
        resource: resource.name satisfies SearchableResource,
        object: resource.object,
        data: page.data.map((hit) => hit.object),
        has_more: page.hasMore,
      };
    }),
  );
  res.status(200).json({
    object: 'dashboard_search',
    q,
    mode,
    groups: groups.filter((group) => group.data.length > 0),
  });
}
