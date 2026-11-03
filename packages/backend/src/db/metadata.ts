import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { METADATA_MAX_KEYS, type MetadataPatch } from '../lib/metadata';

export type { MetadataPatch } from '../lib/metadata';

/**
 * A metadata update, merged by the database in the statement that writes it.
 *
 * Stripe's semantics (ADR 0014 D1): keys in the patch are set, a key sent with
 * an empty string is removed, and keys the patch does not name are kept. Done
 * in SQL rather than read-merge-write so two concurrent updates of different
 * keys both land — a read-modify-write would let the second silently drop the
 * first one's key.
 *
 * The removals are an `ARRAY[...]` of bound parameters, never a JS array
 * interpolated whole: drizzle renders a bare `${array}` as a ROW constructor,
 * which Postgres refuses at runtime.
 */
export function mergedMetadata(
  column: AnyPgColumn,
  patch: MetadataPatch,
): SQL<Record<string, string>> {
  const merged = sql<Record<string, string>>`(${column} || ${JSON.stringify(patch.set)}::jsonb)`;
  if (patch.unset.length === 0) return merged;
  return sql<Record<string, string>>`(${merged} - ARRAY[${sql.join(
    patch.unset.map((key) => sql`${key}`),
    sql`, `,
  )}]::text[])`;
}

/**
 * The key-count limit, judged on the MERGED value — the only place it can be:
 * a patch of one key is legal on its own and illegal on a bag already holding
 * fifty. A row that fails it is simply not updated, and the repository tells
 * that apart from a missing row with a second read.
 */
export function metadataWithinLimit(merged: SQL<Record<string, string>>): SQL {
  return sql`(select count(*) from jsonb_object_keys(${merged})) <= ${METADATA_MAX_KEYS}`;
}
