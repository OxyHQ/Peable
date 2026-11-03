import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { merchants } from '../schema';

/**
 * The `livemode` of the merchant a row belongs to, read in the row's own
 * statement (ADR 0017).
 *
 * Every provider-bound row has a mode, and it is its MERCHANT's: a merchant is
 * registered by one credential environment, `merchants.livemode` is derived from
 * it by the single writer and pinned by `merchants_livemode_agrees_check`, and
 * every child row (`payment_intents`, `refunds`, `transfers`, …) references its
 * merchant. So the mode is stored exactly once and read here, rather than
 * copied onto every table where a copy could disagree with its source.
 *
 * A scalar subquery rather than a join for the reason
 * `paymentIntentRepository`'s `connectedAccountPublicId` gives: the column maps
 * it is placed in are also every `INSERT`/`UPDATE … RETURNING`, and RETURNING
 * cannot join. It names the outer table by its own name, which is valid in all
 * three statement kinds.
 *
 * What it decides: which provider key an operation on that row is sent with
 * (`environmentGuard.ts`'s `selectStoredProvider`), and the `livemode` the row
 * carries on the wire.
 */
export function merchantLivemodeOf(merchantId: AnyPgColumn): SQL<boolean> {
  return sql<boolean>`(select ${merchants.livemode} from ${merchants} where ${merchants.id} = ${merchantId})`;
}
