import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import type { CurrencyCode, PaymentIntentRail, PaymentIntentStatus } from '@peable.to/shared-types';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
// Type-only: this repository must not pull the Stripe SDK into a query path.
import type { ProviderId } from '../../services/providers/provider';
import { paymentIntents } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * Reads and writes for `payment_intents` — the money record.
 */

export interface PaymentIntentRow {
  readonly id: string;
  readonly publicId: string;
  readonly status: PaymentIntentStatus;
  readonly rail: PaymentIntentRail;
  readonly amount: string;
  readonly currency: CurrencyCode;
  /** FairCoin rail only — `null` on a card intent (ADR 0001 D6). */
  readonly network: NetworkType | null;
  /** FairCoin rail only — `null` on a card intent, which reserves no address. */
  readonly address: string | null;
  readonly merchantId: string;
  readonly txid: string | null;
  readonly confirmations: number;
  /** Card rail only — `null` on a FairCoin intent, where the chain is the provider. */
  readonly provider: ProviderId | null;
  /** The provider's own id for the object that moves the money. `null` until it exists. */
  readonly providerObjectId: string | null;
  readonly clientSecret: string;
  readonly metadata: Record<string, string>;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * `idempotency_key` is deliberately absent: it is internal, omitted from the
 * DTO, and nothing outside the create path has a use for it. `client_secret`
 * IS here — the payer needs it, and `verifySecret` compares against it.
 */
const INTENT_COLUMNS = {
  id: paymentIntents.id,
  publicId: paymentIntents.publicId,
  status: paymentIntents.status,
  rail: paymentIntents.rail,
  amount: paymentIntents.amount,
  currency: paymentIntents.currency,
  network: paymentIntents.network,
  address: paymentIntents.address,
  merchantId: paymentIntents.merchantId,
  txid: paymentIntents.txid,
  confirmations: paymentIntents.confirmations,
  provider: paymentIntents.provider,
  providerObjectId: paymentIntents.providerObjectId,
  clientSecret: paymentIntents.clientSecret,
  metadata: paymentIntents.metadata,
  expiresAt: paymentIntents.expiresAt,
  createdAt: paymentIntents.createdAt,
  updatedAt: paymentIntents.updatedAt,
} as const;

interface RawIntentRow {
  readonly status: string;
  readonly rail: string;
  readonly currency: string;
  readonly network: string | null;
  readonly provider: string | null;
  readonly [key: string]: unknown;
}

/** Where the closed-set CHECKs meet TypeScript. Not widenings, and nowhere else to put them. */
function toIntentRow(row: RawIntentRow): PaymentIntentRow {
  return {
    ...row,
    status: row.status as PaymentIntentStatus,
    rail: row.rail as PaymentIntentRail,
    currency: row.currency as CurrencyCode,
    network: row.network as NetworkType | null,
    provider: row.provider as ProviderId | null,
  } as unknown as PaymentIntentRow;
}

export interface InsertPaymentIntentParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly rail: PaymentIntentRail;
  readonly amount: string;
  readonly currency: CurrencyCode;
  /** FairCoin rail only. Both of these are `null` together on a card intent, and
   *  `payment_intents_faircoin_requires_chain_fields_check` refuses the mix. */
  readonly network: NetworkType | null;
  readonly address: string | null;
  /**
   * Card rail only, and REQUIRED there —
   * `payment_intents_card_requires_provider_check` refuses a card intent
   * without one. Never set on faircoin.
   */
  readonly provider: ProviderId | null;
  readonly clientSecret: string;
  readonly idempotencyKey: string;
  readonly metadata: Record<string, string>;
  readonly expiresAt: Date;
}

/**
 * Mint an intent.
 *
 * @returns the new row, or `null` when `(merchant_id, idempotency_key)` already
 *   exists. The caller then re-reads the winner — the race path `createIntent`
 *   already has. Converging on the index rather than reading first is what makes
 *   two concurrent creates with one `Idempotency-Key` produce ONE intent, and
 *   therefore one address, rather than two intents sharing a merchant's counter.
 */
export async function insertPaymentIntent(
  db: DatabaseOrTransaction,
  params: InsertPaymentIntentParams
): Promise<PaymentIntentRow | null> {
  try {
    // Explicit field list, never a spread. `status` and `confirmations` take
    // their column defaults: a caller does not get to mint an intent that is
    // already settled. `currency` and `rail` are now ARGUMENTS rather than
    // defaults — a default would silently make every card intent a FairCoin one.
    const [row] = await db
      .insert(paymentIntents)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        status: 'created',
        rail: params.rail,
        amount: params.amount,
        currency: params.currency,
        network: params.network,
        address: params.address,
        provider: params.provider,
        merchantId: params.merchantId,
        clientSecret: params.clientSecret,
        idempotencyKey: params.idempotencyKey,
        metadata: params.metadata,
        expiresAt: params.expiresAt,
      })
      .returning(INTENT_COLUMNS);
    return row ? toIntentRow(row) : null;
  } catch (error) {
    if (isUniqueViolation(error, 'payment_intents_merchant_id_idempotency_key_key')) {
      return null;
    }
    throw error;
  }
}

/** The idempotency lookup — both the fast path and the race recovery. */
export async function findIntentByIdempotencyKey(
  db: DatabaseOrTransaction,
  merchantId: string,
  idempotencyKey: string
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.merchantId, merchantId),
        eq(paymentIntents.idempotencyKey, idempotencyKey)
      )
    );
  return row ? toIntentRow(row) : null;
}

/** The PAYER path: `pi_…` alone, authorized by `client_secret` rather than by ownership. */
export async function findIntentByPublicId(
  db: DatabaseOrTransaction,
  publicId: string
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(eq(paymentIntents.publicId, publicId));
  return row ? toIntentRow(row) : null;
}

/**
 * The MERCHANT path: `pi_…` scoped to the owner, in ONE predicate.
 *
 * Separate from {@link findIntentByPublicId} rather than a boolean parameter,
 * because the difference is who may see the row. A merchant-authed handler that
 * reached for the unscoped read would return another merchant's intent — an
 * IDOR — and the two names are what makes that visible in a diff. The ownership
 * check is in the WHERE clause, never a comparison after the read, so a missing
 * row and a foreign row are indistinguishable to the caller and both 404.
 */
export async function findIntentForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(eq(paymentIntents.publicId, publicId), eq(paymentIntents.merchantId, merchantId))
    );
  return row ? toIntentRow(row) : null;
}

/**
 * Resolve an intent by its PRIMARY KEY — the reference another row holds.
 *
 * ## Why this exists, and why it is not `findIntentByPublicId`
 *
 * Mongo and Postgres disagree about what an intent REFERENCE is. The Mongo
 * documents stored the public `pi_…` in their foreign-key positions, because
 * `PaymentIntent`'s schema field was itself called `id`; here
 * `checkout_sessions.payment_intent_id` and `webhook_deliveries.payment_intent_id`
 * are real references to `payment_intents.id`, the internal uuid. Both ids are
 * on shipped wire contracts (`CheckoutSession.paymentIntentId`,
 * `WebhookDelivery.intentId` both carry the `pi_…`), so this cannot be settled
 * by changing which id is stored — the two lookups are genuinely different
 * questions and each needs its own function.
 *
 * UNSCOPED, deliberately: both callers have already proved their right to the
 * row through the SESSION that points at it. The merchant path reads the
 * session with `findSessionForMerchant` and the payer path proves possession of
 * the wrapped intent's `client_secret`. Adding a merchant predicate here would
 * be a second authority for a decision the session already made — and the
 * ownership-scoped read that genuinely needs one is
 * {@link findIntentByIdForMerchant}, which is a separate function for exactly
 * that reason.
 */
export async function findIntentById(
  db: DatabaseOrTransaction,
  id: string
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(eq(paymentIntents.id, id));
  return row ? toIntentRow(row) : null;
}

/**
 * By PRIMARY KEY, scoped to the owner — the webhook redelivery path's lookup.
 *
 * Redelivery starts from a `webhook_deliveries` row and must load the intent it
 * names, under merchant authentication. The delivery was ownership-checked, but
 * the intent it points at is loaded by an id that came out of a row rather than
 * out of the request — so the scope is re-stated here, in the WHERE clause,
 * rather than compared after the read. A foreign id and an unknown id are
 * therefore indistinguishable to the caller: both are `null`, both 404, and
 * neither confirms that the row exists.
 *
 * Separate from {@link findIntentById} rather than an optional `merchantId`,
 * for the reason {@link findIntentForMerchant} is separate from
 * {@link findIntentByPublicId}: the difference is who may see the row, and an
 * optional parameter invites the call that omits it.
 *
 * Note the sibling it is easiest to confuse this with. {@link findIntentForMerchant}
 * takes the PUBLIC `pi_…` and this one takes the internal uuid; the signatures
 * are identical, so the compiler cannot tell them apart. What it costs to mix
 * them up is bounded — the two id spaces are disjoint, so a swapped call matches
 * no row and 404s. It never returns a different intent.
 */
export async function findIntentByIdForMerchant(
  db: DatabaseOrTransaction,
  id: string,
  merchantId: string
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(and(eq(paymentIntents.id, id), eq(paymentIntents.merchantId, merchantId)));
  return row ? toIntentRow(row) : null;
}

export interface ListIntentsParams {
  readonly merchantId: string;
  readonly status?: PaymentIntentStatus | undefined;
  readonly limit: number;
  /** The internal id of the `starting_after` cursor row, already resolved and ownership-checked. */
  readonly after?: string | undefined;
}

/**
 * One page, newest first, plus whether another exists.
 *
 * Ordered by the PRIMARY KEY descending — the port of Mongo's `.sort({_id: -1})`.
 * Two separate properties, and only one of them is total:
 *
 *  - **Pagination is exact.** The key is unique and the order is total, so a
 *    keyset walk never repeats or skips a row, whatever the ids happen to be.
 *    Ordering by `created_at` instead would need a tiebreaker and would skip
 *    rows sharing a millisecond with a page boundary.
 *  - **Creation order holds only to the MILLISECOND.** A uuid v7 leads with 48
 *    bits of big-endian milliseconds and `@oxy.so/db`'s generator fills the rest
 *    with randomness — RFC 9562's optional monotonic counter is not used. So
 *    two rows minted in the same millisecond come back in arbitrary relative
 *    order. Measured: 94 of 200 same-millisecond pairs invert, which is the
 *    coin flip you would expect rather than a rare edge.
 *
 * That is a real difference from Mongo, where an ObjectId carries a per-process
 * counter and is therefore monotonic within its one-second timestamp. Nothing
 * in this API promises sub-millisecond ordering, and the pagination contract is
 * unaffected — but do not restate this as "primary-key order is creation order",
 * because at the resolution that matters it is not.
 *
 * Fetches `limit + 1` and reports `hasMore` from the overflow rather than
 * counting, so a page costs one indexed scan and no `count(*)`.
 */
export async function listIntentsForMerchant(
  db: DatabaseOrTransaction,
  params: ListIntentsParams
): Promise<{ data: PaymentIntentRow[]; hasMore: boolean }> {
  const conditions = [eq(paymentIntents.merchantId, params.merchantId)];
  if (params.status !== undefined) conditions.push(eq(paymentIntents.status, params.status));
  if (params.after !== undefined) conditions.push(lt(paymentIntents.id, params.after));

  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(and(...conditions))
    .orderBy(desc(paymentIntents.id))
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  return {
    data: (hasMore ? rows.slice(0, params.limit) : rows).map(toIntentRow),
    hasMore,
  };
}

/**
 * The enrichment lookup: which intents claim these addresses.
 *
 * `inArray`, not a `sql` template holding the array. A bare `${array}` inside a
 * `sql` template renders as a ROW CONSTRUCTOR, which Postgres rejects outright —
 * a runtime error `tsc` cannot see.
 *
 * The empty input short-circuits to save a round trip. It was written here as
 * avoiding a syntax error, and that is NOT true on the drizzle this repository
 * pins: measured on drizzle-orm 0.45.2 against a real server, `inArray(col, [])`
 * renders `where false` and returns no rows.
 */
export async function findIntentsByAddresses(
  db: DatabaseOrTransaction,
  addresses: readonly string[]
): Promise<PaymentIntentRow[]> {
  if (addresses.length === 0) return [];
  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(inArray(paymentIntents.address, [...addresses]));
  return rows.map(toIntentRow);
}

/**
 * Intents that have run out of time.
 *
 * The statuses are a CLOSED, hand-written list and not "everything
 * non-terminal", and that is the whole safety of this query. `approved`,
 * `broadcast` and `confirming` are deliberately absent: a payer has committed
 * funds by then, and expiring one of those would abandon a payment that is
 * on its way — the intent would read `expired` while coins arrived at an address
 * nobody is watching any more. Only the states where nothing has been sent yet
 * are expirable.
 *
 * `requires_action` and `processing` are the card rail's equivalents and are
 * included for the same reason: an SCA challenge nobody completed, and a charge
 * the provider never resolved, are both a checkout the buyer walked away from.
 */
export async function findExpiredIntents(
  db: DatabaseOrTransaction,
  params: { readonly now: Date; readonly limit: number }
): Promise<PaymentIntentRow[]> {
  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        inArray(paymentIntents.status, [
          'created',
          'awaiting_approval',
          'requires_action',
          'processing',
        ]),
        lt(paymentIntents.expiresAt, params.now)
      )
    )
    .orderBy(paymentIntents.expiresAt)
    .limit(params.limit);
  return rows.map(toIntentRow);
}

/**
 * What the settlement watcher polls: in-flight intents carrying a payer-reported
 * txid. Terminal and pre-broadcast intents are never watched, and an intent with
 * no txid has nothing to look up on chain.
 */
export async function findWatchableIntents(
  db: DatabaseOrTransaction,
  statuses: readonly PaymentIntentStatus[]
): Promise<PaymentIntentRow[]> {
  if (statuses.length === 0) return [];
  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        // The rail predicate is NOT redundant with the status one, even though
        // `payment_intents_chain_statuses_are_faircoin_check` makes every
        // `broadcast`/`confirming` row a FairCoin row today. `settled` is a
        // SHARED status: the day this query is asked for one — a reorg sweep, a
        // reconciliation — it would start handing card payments to a watcher
        // that dereferences `address` and `network`. Stating the rail here is
        // what makes "only the FairCoin rail is watchable" a property of the
        // query rather than of the caller's current status list.
        eq(paymentIntents.rail, 'faircoin'),
        inArray(paymentIntents.status, [...statuses]),
        isNotNull(paymentIntents.txid)
      )
    );
  return rows.map(toIntentRow);
}

export interface IntentStateChange {
  /**
   * The status this transition was decided FROM, and the compare half of the
   * compare-and-swap below.
   *
   * REQUIRED, not optional. Every caller reads the intent, hands its status to
   * `applyEvent` to decide a target, and only then writes — so a caller that
   * cannot name where it started is a caller whose decision was made against
   * nothing, and it should not compile.
   */
  readonly from: PaymentIntentStatus;
  readonly status: PaymentIntentStatus;
  readonly txid?: string | undefined;
  readonly confirmations?: number | undefined;
}

/**
 * What an attempted transition did.
 *
 * Three outcomes and not two, because `null` used to mean both "no such row"
 * and "the row moved", and the callers need to tell them apart: a route answers
 * 404 for the first and 409 for the second, and the event drain retries only
 * the second.
 */
export type IntentStateResult =
  | { readonly kind: 'updated'; readonly row: PaymentIntentRow }
  | { readonly kind: 'stale'; readonly current: PaymentIntentStatus }
  | { readonly kind: 'missing' };

/**
 * Advance an intent's state, from a known status to the next one.
 *
 * The transition itself is decided by `services/intentState.ts`; this only
 * records the outcome. `txid` is part of the SAME statement rather than a second
 * write, which is what keeps `payment_intents_broadcast_requires_txid_check`
 * satisfiable: moving to `broadcast` without the txid alongside it is refused by
 * the database, not merely by convention.
 *
 * ## Why `status = from` is in the WHERE
 *
 * This used to be `WHERE id = ?` alone, and the validation lived entirely in
 * `applyEvent` — a PURE function reading a status fetched in an earlier
 * statement. So the state machine was advisory: `ALLOWED` in the shared
 * contract has `expired: []`, and an event racing `expireDueIntents` still
 * wrote `settled` over `expired` and enqueued a second, contradicting outcome
 * for one payment. Every one of the callers reads then writes, so this was not
 * one caller's slip.
 *
 * The idiom is already in this file: {@link linkProviderObject}, thirty lines
 * down, guards on `provider_object_id IS NULL` for exactly this reason. It just
 * never reached the status write.
 *
 * The re-read on a miss is one extra statement on the FAILURE path only, and it
 * buys the distinction between a row that moved and a row that is not there —
 * which is the difference between a 409 and a 404.
 */
export async function updateIntentState(
  db: DatabaseOrTransaction,
  id: string,
  change: IntentStateChange
): Promise<IntentStateResult> {
  const values: Record<string, string | number> = { status: change.status };
  if (change.txid !== undefined) values.txid = change.txid;
  if (change.confirmations !== undefined) values.confirmations = change.confirmations;

  const [row] = await db
    .update(paymentIntents)
    .set(values)
    .where(and(eq(paymentIntents.id, id), eq(paymentIntents.status, change.from)))
    .returning(INTENT_COLUMNS);
  if (row) return { kind: 'updated', row: toIntentRow(row) };

  // Read on the caller's `db` so it sees the same snapshot the failed update
  // did — a separate connection could report a status from after the race.
  const [current] = await db
    .select({ status: paymentIntents.status })
    .from(paymentIntents)
    .where(eq(paymentIntents.id, id));
  if (!current) return { kind: 'missing' };
  // Same cast `toIntentRow` makes on the same column: the CHECK is what keeps
  // the text in the closed set, and drizzle types it as `string`.
  return { kind: 'stale', current: current.status as PaymentIntentStatus };
}

/**
 * Record the provider object this intent became, once the provider has told us
 * what it is.
 *
 * The second half of the two-step create. Guarded on `provider_object_id IS
 * NULL` so it can only ever fill the gap, never overwrite a link — a second
 * provider call for an intent that already has one is a bug (a duplicate
 * charge, or a recovery that raced), and silently repointing the row at the new
 * object would orphan the first charge with nothing recording that it exists.
 *
 * @returns `true` when this call did the linking; `false` when the row was
 *   already linked, which the caller should treat as "someone else got there"
 *   rather than as an error.
 */
export async function linkProviderObject(
  db: DatabaseOrTransaction,
  intentId: string,
  provider: ProviderId,
  providerObjectId: string
): Promise<boolean> {
  const rows = await db
    .update(paymentIntents)
    .set({ providerObjectId })
    .where(
      and(
        eq(paymentIntents.id, intentId),
        eq(paymentIntents.provider, provider),
        isNull(paymentIntents.providerObjectId)
      )
    )
    .returning({ id: paymentIntents.id });
  return rows.length === 1;
}

/**
 * The event drain's lookup: which intent is this provider object?
 *
 * `provider` is part of the key rather than decoration. Object ids are unique
 * within a provider's own numbering and nowhere else, so matching on the id
 * alone would, the day a second provider exists, let one provider's event act
 * on another provider's payment.
 */
export async function findIntentByProviderObject(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerObjectId: string
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.provider, provider),
        eq(paymentIntents.providerObjectId, providerObjectId)
      )
    );
  return row ? toIntentRow(row) : null;
}

/**
 * The statuses an unpaid intent may expire FROM — exactly those whose
 * transition list in shared-types' `ALLOWED` table contains `expired`.
 *
 * What unites them is that the gateway is waiting on a PERSON. `created` and
 * `awaiting_approval` wait on a payer who has not paid; `requires_action` waits
 * on one who opened a 3DS challenge and walked away. None of them has money
 * moving anywhere, so a clock running out is the honest outcome.
 *
 * `approved`, `broadcast` and `confirming` are absent because coins are already
 * on their way and the settlement watcher owns those rows. `processing` is
 * absent for the same reason on the card side — the charge is at the acquirer,
 * and the table refuses it an `expired` edge at all.
 *
 * `requires_action` was NOT in this list when it arrived from
 * `feat/web-read-only-wallet`, and could not have been: the status is part of
 * the card rail, which landed after that branch was cut. The drift was found by
 * the test rather than by review — `expirySweeper.test.ts` re-derives this list
 * from `applyEvent` and went red on the merge. Without it, an abandoned 3DS
 * checkout would sit in `requires_action` forever, never expiring, and the
 * merchant would never get the `payment_intent.expired` they release an
 * inventory reservation on.
 */
export const EXPIRABLE_STATUSES: readonly PaymentIntentStatus[] = [
  'created',
  'awaiting_approval',
  'requires_action',
];

/**
 * Claim a BOUNDED batch of intents whose expiry has passed, in ONE statement.
 *
 * The claim and the read are the same `UPDATE … RETURNING`, for the same reason
 * the derivation-index reservation is: the gateway runs on more than one ECS
 * task and every one of them sweeps. Split into a SELECT followed by an UPDATE,
 * both sweepers would read the same rows and the merchant would get
 * `payment_intent.expired` twice for one intent.
 *
 * The `for update skip locked` subquery is what makes that true WITHOUT either
 * sweeper waiting: a plain `UPDATE … WHERE status IN (…)` also returns each row
 * to one caller under READ COMMITTED, but only because the second sweeper
 * BLOCKS on the row lock until the first commits. `skip locked` steps over the
 * rows another task holds instead — the same idiom `claimDueDeliveries` uses
 * one table over.
 *
 * `limit` is not decoration either. Unbounded, the FIRST sweep after this ships
 * expires every historical intent in one transaction, holding every one of
 * those row locks until it commits and enqueueing the whole backlog of webhooks
 * in a single burst. A bounded batch drains at a rate the caller chooses.
 */
export async function expireDueIntents(
  db: DatabaseOrTransaction,
  now: Date,
  limit: number
): Promise<PaymentIntentRow[]> {
  const due = db
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        inArray(paymentIntents.status, [...EXPIRABLE_STATUSES]),
        lt(paymentIntents.expiresAt, now)
      )
    )
    // Oldest first: a stream that expired its newest arrivals first would
    // starve its own head under a backlog.
    .orderBy(paymentIntents.expiresAt)
    .limit(limit)
    .for('update', { skipLocked: true });

  const rows = await db
    .update(paymentIntents)
    .set({ status: 'expired' })
    .where(sql`${paymentIntents.id} in (${due})`)
    .returning(INTENT_COLUMNS);
  return rows.map(toIntentRow);
}
