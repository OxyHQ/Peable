import { type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';

/**
 * The public id of the row another column names, as a scalar subquery.
 *
 * Raw, aliased and table-qualified on purpose (`CONVENTIONS.md` §Payments
 * core): drizzle renders a table's own columns UNqualified in `INSERT/UPDATE …
 * RETURNING`, and an unqualified `"id"` inside a subquery binds to the
 * subquery's table — a silently wrong answer, not an error.
 */
export function publicIdOf(
  targetTable: string,
  outerTable: string,
  outerColumn: string,
): SQL<string | null> {
  return sql<string | null>`(${sql.raw(
    `select x.public_id from ${targetTable} x where x.id = "${outerTable}"."${outerColumn}"`,
  )})`;
}

/** {@link publicIdOf} for a column that is never NULL. */
export function requiredPublicIdOf(
  targetTable: string,
  outerTable: string,
  outerColumn: string,
): SQL<string> {
  return publicIdOf(targetTable, outerTable, outerColumn) as SQL<string>;
}

/** The database's own instant, at the millisecond precision every timestamp is stored at. */
export const nowMs = sql`date_trunc('milliseconds', now())`;

let lastOrderedId = '';

/**
 * A uuid v7 strictly greater than every one this process minted before.
 *
 * A plain uuid v7 is ordered only to the MILLISECOND (its tail is random), and
 * an invoice's lines — a credit then the charge that replaces it — are written
 * within one. Lines and invoice items are read back in primary-key order, so
 * their ids must be in the order they were drafted: when the clock has not
 * moved past the last id, the last id plus one is used instead. The increment
 * stays in the random tail, so the version and variant bits are untouched.
 */
export function orderedId(): string {
  let candidate = uuidv7();
  if (candidate <= lastOrderedId) {
    const hex = lastOrderedId.replace(/-/g, '');
    const next = (BigInt(`0x${hex.slice(20)}`) + 1n).toString(16).padStart(12, '0');
    const joined = `${hex.slice(0, 20)}${next}`;
    candidate = `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
  }
  lastOrderedId = candidate;
  return candidate;
}
