import { and, asc, desc, gt, gte, lt, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * The repository half of every list (ADR 0014 D1): one keyset walk over a uuid
 * v7 primary key, newest first.
 *
 * ## Why one helper
 *
 * Each list used to write its own `lt(id, after)` / `desc(id)` / `limit + 1`,
 * and they had drifted: contributions walked `public_id` (random hex, so a
 * page boundary skipped and repeated rows), the per-intent sub-lists had no
 * cursor at all, and only some accepted `starting_after`. A list contract that
 * is spelled out per route is a contract every route can get wrong; this is
 * the one place it is spelled.
 *
 * ## The order, and what it promises
 *
 * Primary key descending. The key is unique, so the walk is exact — it never
 * repeats or skips a row. It is creation order only to the MILLISECOND (see
 * `listIntentsForMerchant`'s note): uuid v7's tail is random, not a counter.
 *
 * ## `ending_before` pages BACKWARDS and answers newest first
 *
 * Stripe's semantics: the page is the `limit` rows immediately NEWER than the
 * cursor, still presented newest first, and `has_more` says whether there are
 * newer ones still. That is a walk in ascending order from the cursor, cut at
 * `limit + 1`, then reversed — which is why `finish` is part of the helper
 * rather than left to the caller: a caller that forgot to reverse would hand
 * back a page in the opposite order to every other page of the same list.
 */

/** `created[gt|gte|lt|lte]`, integer Unix seconds. */
export interface CreatedRange {
  readonly gt?: number | undefined;
  readonly gte?: number | undefined;
  readonly lt?: number | undefined;
  readonly lte?: number | undefined;
}

export interface KeysetPage {
  /** 1–100, already validated. */
  readonly limit: number;
  /** INTERNAL primary key of the `starting_after` row, resolved inside the caller's scope. */
  readonly after?: string | undefined;
  /** INTERNAL primary key of the `ending_before` row, resolved inside the caller's scope. */
  readonly before?: string | undefined;
  readonly created?: CreatedRange | undefined;
}

export interface Keyset {
  /** The cursor and `created` predicates; `and` it with the caller's own scope. */
  readonly where: SQL | undefined;
  readonly orderBy: SQL;
  /** `limit + 1`: the extra row answers `has_more` without a `count(*)`. */
  readonly limit: number;
  /** Cut the overflow row and restore newest-first order. */
  finish<T>(rows: readonly T[]): { data: T[]; hasMore: boolean };
}

/**
 * Seconds → the half-open instant range they denote.
 *
 * Every `created` on the wire is FLOORED to the second (`lib/time.ts`), so a
 * row whose wire value is `X` was created somewhere in `[X, X + 1)`. Each
 * operator is translated against that, so a filter agrees with the value the
 * caller can see: `created[lte]=X` includes a row created at `X.9`, which a
 * naive `created_at <= X` would drop.
 */
function createdPredicates(column: AnyPgColumn, range: CreatedRange): SQL[] {
  const at = (seconds: number) => new Date(seconds * 1000);
  const out: SQL[] = [];
  if (range.gte !== undefined) out.push(gte(column, at(range.gte)));
  if (range.gt !== undefined) out.push(gte(column, at(range.gt + 1)));
  if (range.lt !== undefined) out.push(lt(column, at(range.lt)));
  if (range.lte !== undefined) out.push(lt(column, at(range.lte + 1)));
  return out;
}

/**
 * Build the walk for one list.
 *
 * @param id      the uuid v7 primary key the walk runs on.
 * @param created the instant `created[...]` filters — normally `created_at`;
 *                a resource whose wire `created` means something else passes
 *                that column instead.
 */
export function keyset(id: AnyPgColumn, created: AnyPgColumn, page: KeysetPage): Keyset {
  const backwards = page.before !== undefined;
  const conditions: SQL[] = createdPredicates(created, page.created ?? {});
  if (page.after !== undefined) conditions.push(lt(id, page.after));
  if (page.before !== undefined) conditions.push(gt(id, page.before));
  return {
    where: conditions.length === 0 ? undefined : and(...conditions),
    orderBy: backwards ? asc(id) : desc(id),
    limit: page.limit + 1,
    finish<T>(rows: readonly T[]) {
      const hasMore = rows.length > page.limit;
      const data = rows.slice(0, page.limit);
      if (backwards) data.reverse();
      return { data, hasMore };
    },
  };
}
