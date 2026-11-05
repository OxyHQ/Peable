import { publicColumns as publicColumnsOf, type PublicColumns } from '@oxy.so/db/assert';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Columns no ordinary read returns.
 *
 * `db.select(publicColumns(merchants)).from(merchants)` omits every column
 * listed here from the result AND from the row TYPE, so a serializer that
 * reaches for one fails `tsc` instead of shipping it. A path that legitimately
 * needs one names it: `db.select({ id: webhookEndpoints.id, secret:
 * webhookEndpoints.secret })`, which reads differently and stays greppable.
 *
 * ## What is deliberately NOT here, and why
 *
 * The registry is the set of columns that must not reach ANY client — not the
 * set of columns that are sensitive. Two obvious candidates are excluded on
 * that distinction, and it should not be added without changing the
 * serializer that publishes it:
 *
 *  - `payment_intents.client_secret` is in `toPaymentIntentDTO`, which the
 *    PAYER loads — possession of it is what authorizes `submit_tx`.
 *
 * Listing it would not withhold it; it would make every read of the table name
 * it explicitly, which is the opposite of a guard. There is no key column left
 * to protect: FairCoin derives from the recipient's PUBLIC identity key (ADR
 * 0021 D5).
 */
export const PROTECTED_COLUMNS = {
  webhookEndpoints: [
    // The HMAC keys deliveries are signed with. Shown once by the create and
    // the roll responses, which hold the value they just generated; read only
    // by `findEndpointSigningTarget`, to sign.
    'secret',
    'previousSecret',
  ],
} as const;

/**
 * The sanctioned select list for `table` — every column minus whatever
 * {@link PROTECTED_COLUMNS} withholds.
 *
 * Wrapped rather than imported directly at each call site so the registry is
 * bound once. A table with no entry gets all of its columns, so this is the
 * right call for every table and stays correct the moment one gains an entry.
 */
export function publicColumns<T extends PgTable>(
  table: T,
): PublicColumns<T, typeof PROTECTED_COLUMNS> {
  return publicColumnsOf(table, PROTECTED_COLUMNS);
}
