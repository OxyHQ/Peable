import { and, count, eq, inArray, isNotNull, isNull, lt, type SQL, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import {
  EXPIRABLE_STATUSES as SHARED_EXPIRABLE_STATUSES,
  type CardRailPaymentMethodType,
  type CurrencyCode,
  type PaymentIntentCancellationReason,
  type PaymentIntentCaptureMethod,
  type PaymentIntentLastPaymentError,
  type PaymentIntentRail,
  type PaymentIntentSetupFutureUsage,
  type PaymentIntentStatus,
  type Shipping,
} from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
// Type-only: this repository must not pull the Stripe SDK into a query path.
import type { ProviderId } from '../../services/providers/provider';
import { connectedAccounts, customers, merchants, paymentIntents, paymentMethods } from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import type { DatabaseOrTransaction } from '../postgres';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';

/**
 * Reads and writes for `payment_intents` — the money record.
 */

export interface PaymentIntentRow {
  /**
   * The mode this row lives in — its merchant's, read in the same statement
   * (`merchantLivemodeOf`, ADR 0017). Selects the provider key any operation on
   * it is sent with, and is what the wire calls `livemode`.
   */
  readonly livemode: boolean;
  readonly id: string;
  readonly paymentLinkId?: string | null;
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
  /**
   * The seller this payment is made on behalf of — the INTERNAL id, which is
   * what `payment_intents.connected_account_id` references (ADR 0012 D5).
   * `null`/absent on a payment to the merchant itself. Optional in the type, as
   * `paymentLinkId` is, so a fixture that predates it still describes a row.
   */
  readonly connectedAccountId?: string | null;
  /**
   * The same seller's PUBLIC `ca_…`, read in the same statement — the wire
   * contract promises a `ca_…`, and this is the one translation of it, so no
   * serializer has to look it up (or reach for the internal id instead).
   */
  readonly connectedAccountPublicId?: string | null;
  /**
   * A destination charge (ADR 0015 §2), card only: INTERNAL account ids (what
   * the columns reference) and their PUBLIC `ca_…` read in the same statement,
   * plus the transfer amount and Orbit's fee instruction. Optional in the type,
   * as `connectedAccountId` is, so an older fixture still describes a row.
   */
  readonly transferDestinationId?: string | null;
  readonly transferDestinationPublicId?: string | null;
  readonly transferAmount?: string | null;
  readonly onBehalfOfId?: string | null;
  readonly onBehalfOfPublicId?: string | null;
  readonly applicationFeeAmount?: string | null;
  readonly txid: string | null;
  readonly confirmations: number;
  /** Card rail only — `null` on a FairCoin intent, where the chain is the provider. */
  readonly provider: ProviderId | null;
  /** The provider's own id for the object that moves the money. `null` until it exists. */
  readonly providerObjectId: string | null;
  /**
   * The provider's id for the CHARGE the payment produced — a DIFFERENT object
   * from `providerObjectId`, and the one a transfer's source must name.
   */
  readonly providerChargeId: string | null;
  readonly clientSecret: string;
  readonly metadata: Record<string, string>;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /**
   * The merchant's PUBLIC `merch_…`, read in the same statement — what the wire
   * calls `merchant_id`. Never the internal `merchantId` above.
   */
  readonly merchantPublicId: string;
  /** The merchant's confirmation threshold, read with the row — `faircoin.required_confirmations`. */
  readonly requiredConfirmations: number;
  /** INTERNAL id of the customer (ADR 0016), and its public `cus_…` beside it. */
  readonly customerId: string | null;
  readonly customerPublicId: string | null;
  /** INTERNAL id of the saved card, and its public `pm_…` beside it. Card only. */
  readonly paymentMethodId: string | null;
  readonly paymentMethodPublicId: string | null;
  /** The `ch_…` of the authorization that succeeded, when there is one. Card only. */
  readonly latestChargePublicId: string | null;
  /** Card only: what the payer may pay with, fixed at creation. `null` on the chain. */
  readonly paymentMethodTypes: CardRailPaymentMethodType[] | null;
  /** INTERNAL id of the configuration it offers, and its public `pmc_…`. Card only. */
  readonly paymentMethodConfigurationId: string | null;
  readonly paymentMethodConfigurationPublicId: string | null;
  readonly captureMethod: PaymentIntentCaptureMethod;
  readonly setupFutureUsage: PaymentIntentSetupFutureUsage | null;
  readonly description: string | null;
  readonly receiptEmail: string | null;
  readonly statementDescriptorSuffix: string | null;
  readonly shipping: Shipping | null;
  readonly lastPaymentError: PaymentIntentLastPaymentError | null;
  readonly cancellationReason: PaymentIntentCancellationReason | null;
  readonly canceledAt: Date | null;
  readonly amountReceived: string;
  /**
   * The sum of SUCCEEDED refunds — money that actually went back. Read in the
   * same statement, never stored: the refund rows are the one home of that fact.
   */
  readonly amountRefunded: string;
}

/**
 * `idempotency_key` is deliberately absent: it is internal, omitted from the
 * DTO, and nothing outside the create path has a use for it. `client_secret`
 * IS here — the payer needs it, and `verifySecret` compares against it.
 */
const INTENT_COLUMNS = {
  livemode: merchantLivemodeOf(paymentIntents.merchantId),
  paymentLinkId: paymentIntents.paymentLinkId,
  id: paymentIntents.id,
  publicId: paymentIntents.publicId,
  status: paymentIntents.status,
  rail: paymentIntents.rail,
  amount: paymentIntents.amount,
  currency: paymentIntents.currency,
  network: paymentIntents.network,
  address: paymentIntents.address,
  merchantId: paymentIntents.merchantId,
  connectedAccountId: paymentIntents.connectedAccountId,
  /**
   * A scalar subquery rather than a join, because this map is also every
   * `INSERT`/`UPDATE … RETURNING` in this file — and RETURNING cannot join. It
   * names the target table by its own name, which is valid in all three
   * statement kinds; an ALIASED read of `payment_intents` would need its own
   * column map.
   */
  connectedAccountPublicId: sql<
    string | null
  >`(select ${connectedAccounts.publicId} from ${connectedAccounts} where ${connectedAccounts.id} = ${paymentIntents.connectedAccountId})`,
  transferDestinationId: paymentIntents.transferDestinationId,
  transferDestinationPublicId: sql<string | null>`${sql.raw(
    '(select ca.public_id from connected_accounts ca where ca.id = "payment_intents"."transfer_destination_id")',
  )}`,
  transferAmount: paymentIntents.transferAmount,
  onBehalfOfId: paymentIntents.onBehalfOfId,
  onBehalfOfPublicId: sql<string | null>`${sql.raw(
    '(select ca.public_id from connected_accounts ca where ca.id = "payment_intents"."on_behalf_of_id")',
  )}`,
  applicationFeeAmount: paymentIntents.applicationFeeAmount,
  txid: paymentIntents.txid,
  confirmations: paymentIntents.confirmations,
  provider: paymentIntents.provider,
  providerObjectId: paymentIntents.providerObjectId,
  providerChargeId: paymentIntents.providerChargeId,
  clientSecret: paymentIntents.clientSecret,
  metadata: paymentIntents.metadata,
  expiresAt: paymentIntents.expiresAt,
  createdAt: paymentIntents.createdAt,
  updatedAt: paymentIntents.updatedAt,
  // Scalar subqueries for the same reason as `connectedAccountPublicId`: this
  // map is every RETURNING in this file, and RETURNING cannot join.
  merchantPublicId: sql<string>`(select ${merchants.publicId} from ${merchants} where ${merchants.id} = ${paymentIntents.merchantId})`,
  requiredConfirmations: sql<number>`(select ${merchants.requiredConfirmations} from ${merchants} where ${merchants.id} = ${paymentIntents.merchantId})`,
  customerId: paymentIntents.customerId,
  customerPublicId: sql<
    string | null
  >`(select ${customers.publicId} from ${customers} where ${customers.id} = ${paymentIntents.customerId})`,
  paymentMethodId: paymentIntents.paymentMethodId,
  paymentMethodPublicId: sql<
    string | null
  >`(select ${paymentMethods.publicId} from ${paymentMethods} where ${paymentMethods.id} = ${paymentIntents.paymentMethodId})`,
  // Raw and table-qualified: drizzle renders these columns UNqualified in an
  // INSERT/UPDATE … RETURNING, and an unqualified `"id"` inside a subquery
  // over `charges` or `refunds` would bind to THAT table's own `id`.
  latestChargePublicId: sql<string | null>`${sql.raw(
    '(select ch.public_id from charges ch where ch.payment_intent_id = "payment_intents"."id")',
  )}`,
  paymentMethodTypes: paymentIntents.paymentMethodTypes,
  paymentMethodConfigurationId: paymentIntents.paymentMethodConfigurationId,
  paymentMethodConfigurationPublicId: sql<string | null>`${sql.raw(
    '(select pmc.public_id from payment_method_configurations pmc where pmc.id = "payment_intents"."payment_method_configuration_id")',
  )}`,
  captureMethod: paymentIntents.captureMethod,
  setupFutureUsage: paymentIntents.setupFutureUsage,
  description: paymentIntents.description,
  receiptEmail: paymentIntents.receiptEmail,
  statementDescriptorSuffix: paymentIntents.statementDescriptorSuffix,
  shipping: paymentIntents.shipping,
  lastPaymentError: paymentIntents.lastPaymentError,
  cancellationReason: paymentIntents.cancellationReason,
  canceledAt: paymentIntents.canceledAt,
  amountReceived: paymentIntents.amountReceived,
  amountRefunded: sql<string>`${sql.raw(
    `(select coalesce(sum(r.amount::numeric), 0)::text from refunds r where r.payment_intent_id = "payment_intents"."id" and r.status = 'succeeded')`,
  )}`,
} as const;

interface RawIntentRow {
  readonly status: string;
  readonly rail: string;
  readonly currency: string;
  readonly network: string | null;
  readonly provider: string | null;
  readonly requiredConfirmations: number | string;
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
    // A scalar subquery's type is not known to the driver's decoder by column,
    // so an `int4` read this way is coerced here once.
    requiredConfirmations: Number(row.requiredConfirmations),
  } as unknown as PaymentIntentRow;
}

export interface InsertPaymentIntentParams {
  readonly paymentLinkId?: string | null;
  readonly publicId: string;
  readonly merchantId: string;
  /**
   * The seller's INTERNAL id for an on-behalf payment (ADR 0012 D5), whose
   * `address` the caller derived from that seller's key. FairCoin only —
   * `payment_intents_connected_account_is_faircoin_check` — and the account
   * must belong to `merchantId` with this intent's `network`, or
   * `payment_intents_connected_account_network_fkey` refuses the row.
   */
  readonly connectedAccountId?: string | null;
  /**
   * The destination charge decided by `services/money/chargeModel.ts`
   * (ADR 0015 §2). Card only; every one NULL on a platform charge.
   */
  readonly transferDestinationId?: string | null;
  readonly transferAmount?: string | null;
  readonly onBehalfOfId?: string | null;
  readonly applicationFeeAmount?: string | null;
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
  /**
   * Where the intent starts (ADR 0019): `requires_action` on the chain (the
   * payer must broadcast), `requires_payment_method` or `requires_confirmation`
   * on a card. Never a status that claims money moved.
   */
  readonly status: 'requires_action' | 'requires_payment_method' | 'requires_confirmation';
  readonly customerId?: string | null;
  readonly paymentMethodId?: string | null;
  /** Card only, and required there (`payment_intents_payment_method_types_rail_check`). */
  readonly paymentMethodTypes?: readonly CardRailPaymentMethodType[] | null;
  readonly paymentMethodConfigurationId?: string | null;
  readonly captureMethod?: PaymentIntentCaptureMethod;
  readonly setupFutureUsage?: PaymentIntentSetupFutureUsage | null;
  readonly description?: string | null;
  readonly receiptEmail?: string | null;
  readonly statementDescriptorSuffix?: string | null;
  readonly shipping?: Shipping | null;
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
  params: InsertPaymentIntentParams,
): Promise<PaymentIntentRow | null> {
  // Explicit field list, never a spread. `status` is one of the three
  // starting statuses (the type says so) and `confirmations` takes its
  // default: a caller does not get to mint an intent that already succeeded. `currency` and `rail` are now ARGUMENTS rather than
  // defaults — a default would silently make every card intent a FairCoin one.
  const [row] = await db
    .insert(paymentIntents)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      paymentLinkId: params.paymentLinkId ?? null,
      status: params.status,
      rail: params.rail,
      amount: params.amount,
      currency: params.currency,
      network: params.network,
      address: params.address,
      provider: params.provider,
      merchantId: params.merchantId,
      connectedAccountId: params.connectedAccountId ?? null,
      transferDestinationId: params.transferDestinationId ?? null,
      transferAmount: params.transferAmount ?? null,
      onBehalfOfId: params.onBehalfOfId ?? null,
      applicationFeeAmount: params.applicationFeeAmount ?? null,
      customerId: params.customerId ?? null,
      paymentMethodId: params.paymentMethodId ?? null,
      paymentMethodTypes: params.paymentMethodTypes ? [...params.paymentMethodTypes] : null,
      paymentMethodConfigurationId: params.paymentMethodConfigurationId ?? null,
      captureMethod: params.captureMethod ?? 'automatic',
      setupFutureUsage: params.setupFutureUsage ?? null,
      description: params.description ?? null,
      receiptEmail: params.receiptEmail ?? null,
      statementDescriptorSuffix: params.statementDescriptorSuffix ?? null,
      shipping: params.shipping ?? null,
      clientSecret: params.clientSecret,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
      expiresAt: params.expiresAt,
    })
    // `on conflict do nothing`, not a caught unique violation: the insert runs
    // inside the transaction that also records `payment_intent.created`, and a
    // violation there would abort that transaction, catch or no catch.
    .onConflictDoNothing({ target: [paymentIntents.merchantId, paymentIntents.idempotencyKey] })
    .returning(INTENT_COLUMNS);
  return row ? toIntentRow(row) : null;
}

/** The idempotency lookup — both the fast path and the race recovery. */
export async function findIntentByIdempotencyKey(
  db: DatabaseOrTransaction,
  merchantId: string,
  idempotencyKey: string,
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.merchantId, merchantId),
        eq(paymentIntents.idempotencyKey, idempotencyKey),
      ),
    );
  return row ? toIntentRow(row) : null;
}

/**
 * Take the row lock on one intent, inside the caller's transaction.
 *
 * The settlement budget's serialization point. "How much of this payment has
 * already been promised to sellers" is a question whose answer two concurrent
 * settlements of the same cart would both read as the same number — and both
 * would then pass a budget check that only one of them should. Locking the
 * PAYMENT rather than the transfer rows is what makes the check exclusive:
 * every settlement out of one payment has to queue behind the same row,
 * including the first one, which has no transfer rows to lock.
 *
 * @throws when called outside a transaction — `for update` outside one takes a
 *   lock that is released immediately, which is the same as no lock at all.
 *   Not enforced here (the driver cannot tell), which is why the single caller
 *   is inside `db.transaction` and says so.
 */
export async function lockIntentForUpdate(
  tx: DatabaseOrTransaction,
  id: string,
): Promise<PaymentIntentRow | null> {
  const [row] = await tx
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(eq(paymentIntents.id, id))
    .for('update');
  return row ? toIntentRow(row) : null;
}

/** The PAYER path: `pi_…` alone, authorized by `client_secret` rather than by ownership. */
export async function findIntentByPublicId(
  db: DatabaseOrTransaction,
  publicId: string,
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
  merchantId: string,
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(and(eq(paymentIntents.publicId, publicId), eq(paymentIntents.merchantId, merchantId)));
  return row ? toIntentRow(row) : null;
}

/**
 * Resolve an intent by its PRIMARY KEY — the reference another row holds.
 *
 * ## Why this exists, and why it is not `findIntentByPublicId`
 *
 * An intent REFERENCE is not the id a payer or merchant names.
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
  id: string,
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
  merchantId: string,
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
  /** Only payments on behalf of this seller — its INTERNAL id, already resolved and ownership-checked. */
  readonly connectedAccountId?: string | undefined;
  /** Only the payments minted from this link — its INTERNAL id, already resolved and ownership-checked. */
  readonly paymentLinkId?: string | undefined;
  /** Only this customer's payments — its INTERNAL id, already resolved and ownership-checked. */
  readonly customerId?: string | undefined;
  /**
   * A search predicate compiled by `lib/search` from a validated query over
   * this table's own fields — never caller text. AND-ed beneath the merchant.
   */
  readonly search?: SQL | undefined;
  readonly page: KeysetPage;
}

function intentListWhere(params: Omit<ListIntentsParams, 'page'>): SQL | undefined {
  return and(
    eq(paymentIntents.merchantId, params.merchantId),
    params.status === undefined ? undefined : eq(paymentIntents.status, params.status),
    params.connectedAccountId === undefined
      ? undefined
      : eq(paymentIntents.connectedAccountId, params.connectedAccountId),
    params.paymentLinkId === undefined
      ? undefined
      : eq(paymentIntents.paymentLinkId, params.paymentLinkId),
    params.customerId === undefined ? undefined : eq(paymentIntents.customerId, params.customerId),
    params.search,
  );
}

/**
 * One page, newest first, plus whether another exists.
 *
 * Ordered by the PRIMARY KEY descending, through `db/keyset.ts`.
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
 * Nothing in this API promises sub-millisecond ordering, and the pagination contract is
 * unaffected — but do not restate this as "primary-key order is creation order",
 * because at the resolution that matters it is not.
 */
export async function listIntentsForMerchant(
  db: DatabaseOrTransaction,
  params: ListIntentsParams,
): Promise<{ data: PaymentIntentRow[]; hasMore: boolean }> {
  const walk = keyset(paymentIntents.id, paymentIntents.createdAt, params.page);
  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(and(intentListWhere(params), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toIntentRow));
}

/** How many intents {@link listIntentsForMerchant} would walk — a search's `total_count`. */
export async function countIntentsForMerchant(
  db: DatabaseOrTransaction,
  params: Omit<ListIntentsParams, 'page'>,
): Promise<number> {
  const [row] = await db.select({ n: count() }).from(paymentIntents).where(intentListWhere(params));
  return row?.n ?? 0;
}

/**
 * Several intents by PUBLIC id, scoped to the merchant in the predicate — the
 * `expand[]` loader. One query for a whole page rather than one per row.
 */
export async function findIntentsForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<PaymentIntentRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.merchantId, merchantId),
        inArray(paymentIntents.publicId, [...publicIds]),
      ),
    );
  return rows.map(toIntentRow);
}

/**
 * Several intents by PRIMARY KEY — the references a page of sessions holds.
 * Unscoped for `findIntentById`'s reason: every caller has already proved its
 * right to the rows that point here.
 */
export async function findIntentsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<PaymentIntentRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(inArray(paymentIntents.id, [...ids]));
  return rows.map(toIntentRow);
}

/** The merchant's own fields on an intent — what `POST /v1/payment_intents/:id` changes. */
export interface IntentDetailsPatch {
  readonly metadata?: MetadataPatch | undefined;
  readonly description?: string | null | undefined;
  readonly receiptEmail?: string | null | undefined;
  readonly shipping?: Shipping | null | undefined;
}

/**
 * Update the merchant's own fields on one intent — never the payment itself or
 * its status, which move only through their own operations.
 *
 * Merged in ONE statement (`db/metadata.ts`), scoped to the merchant in the
 * predicate. `limit_exceeded` is distinct from `missing` because the two are
 * different answers: 400 naming `metadata`, and 404.
 */
export async function updateIntentDetails(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
  patch: IntentDetailsPatch,
): Promise<PaymentIntentRow | 'missing' | 'limit_exceeded'> {
  const scope = and(
    eq(paymentIntents.publicId, publicId),
    eq(paymentIntents.merchantId, merchantId),
  );
  const merged =
    patch.metadata === undefined
      ? undefined
      : mergedMetadata(paymentIntents.metadata, patch.metadata);
  const [row] = await db
    .update(paymentIntents)
    .set({
      ...(merged !== undefined ? { metadata: merged } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.receiptEmail !== undefined ? { receiptEmail: patch.receiptEmail } : {}),
      ...(patch.shipping !== undefined ? { shipping: patch.shipping } : {}),
    })
    .where(and(scope, merged === undefined ? undefined : metadataWithinLimit(merged)))
    .returning(INTENT_COLUMNS);
  if (row) return toIntentRow(row);
  const [exists] = await db.select({ id: paymentIntents.id }).from(paymentIntents).where(scope);
  return exists ? 'limit_exceeded' : 'missing';
}

/**
 * Set the payment method a confirmation uses (and what came with it), on an
 * intent still waiting for one — the CAS half is `status = from`, so a
 * confirmation racing another cannot repoint a payment that already moved.
 */
export async function setIntentPaymentMethod(
  db: DatabaseOrTransaction,
  id: string,
  from: PaymentIntentStatus,
  fields: {
    readonly paymentMethodId: string;
    readonly setupFutureUsage?: PaymentIntentSetupFutureUsage | undefined;
    readonly receiptEmail?: string | undefined;
    readonly shipping?: Shipping | undefined;
  },
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .update(paymentIntents)
    .set({
      paymentMethodId: fields.paymentMethodId,
      ...(fields.setupFutureUsage !== undefined
        ? { setupFutureUsage: fields.setupFutureUsage }
        : {}),
      ...(fields.receiptEmail !== undefined ? { receiptEmail: fields.receiptEmail } : {}),
      ...(fields.shipping !== undefined ? { shipping: fields.shipping } : {}),
    })
    .where(and(eq(paymentIntents.id, id), eq(paymentIntents.status, from)))
    .returning(INTENT_COLUMNS);
  return row ? toIntentRow(row) : null;
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
  addresses: readonly string[],
): Promise<PaymentIntentRow[]> {
  if (addresses.length === 0) return [];
  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(inArray(paymentIntents.address, [...addresses]));
  return rows.map(toIntentRow);
}

/**
 * What the settlement watcher polls: in-flight intents carrying a payer-reported
 * txid. Terminal and pre-broadcast intents are never watched, and an intent with
 * no txid has nothing to look up on chain.
 */
export async function findWatchableIntents(
  db: DatabaseOrTransaction,
  statuses: readonly PaymentIntentStatus[],
): Promise<PaymentIntentRow[]> {
  if (statuses.length === 0) return [];
  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        // The rail predicate is NOT redundant with the status one: since
        // ADR 0019 `processing` is a SHARED status — a card payment the acquirer
        // is still working on is `processing` too — and handing one to the
        // watcher would dereference an `address` and `network` it does not
        // have. Stating the rail here is what makes "only the FairCoin rail is
        // watchable" a property of the query rather than of the caller.
        eq(paymentIntents.rail, 'faircoin'),
        inArray(paymentIntents.status, [...statuses]),
        isNotNull(paymentIntents.txid),
      ),
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
  /**
   * Why the attempt that caused THIS transition failed. Every transition writes
   * the column: absent here means "cleared", because a stale error describing an
   * earlier attempt would sit beside a status that has moved on (ADR 0019).
   */
  readonly lastPaymentError?: PaymentIntentLastPaymentError | undefined;
  /** Only with `status: 'canceled'`; `canceled_at` is stamped by the same statement. */
  readonly cancellationReason?: PaymentIntentCancellationReason | undefined;
  /**
   * Only with `status: 'succeeded'`: what was captured, when less than the
   * amount (a partial manual capture). Defaults to the whole amount; every
   * other status resets it to `"0"` — a reorg rewinding a FairCoin payment
   * un-receives it.
   */
  readonly amountReceived?: string | undefined;
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
 * write, which is what keeps `payment_intents_processing_requires_txid_check`
 * satisfiable: moving a FairCoin intent to `processing` without the txid
 * alongside it is refused by the database, not merely by convention. So are the
 * fields a transition decides with it (ADR 0019): `last_payment_error`,
 * `cancellation_reason` / `canceled_at`, and `amount_received`.
 *
 * ## Why `status = from` is in the WHERE
 *
 * This used to be `WHERE id = ?` alone, and the validation lived entirely in
 * `applyEvent` — a PURE function reading a status fetched in an earlier
 * statement. So the state machine was advisory: `ALLOWED` in the shared
 * contract has `canceled: []`, and an event racing `expireDueIntents` still
 * wrote `succeeded` over an expired intent and enqueued a second, contradicting outcome
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
  change: IntentStateChange,
): Promise<IntentStateResult> {
  const canceled = change.status === 'canceled';
  const values = {
    status: change.status,
    lastPaymentError: change.lastPaymentError ?? null,
    cancellationReason: canceled ? (change.cancellationReason ?? null) : null,
    canceledAt: canceled ? sql`date_trunc('milliseconds', now())` : null,
    amountReceived:
      change.status !== 'succeeded'
        ? '0'
        : change.amountReceived !== undefined
          ? change.amountReceived
          : sql`${paymentIntents.amount}`,
    ...(change.txid !== undefined ? { txid: change.txid } : {}),
    ...(change.confirmations !== undefined ? { confirmations: change.confirmations } : {}),
  };

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
  providerObjectId: string,
): Promise<boolean> {
  const rows = await db
    .update(paymentIntents)
    .set({ providerObjectId })
    .where(
      and(
        eq(paymentIntents.id, intentId),
        eq(paymentIntents.provider, provider),
        isNull(paymentIntents.providerObjectId),
      ),
    )
    .returning({ id: paymentIntents.id });
  return rows.length === 1;
}

/**
 * Record the CHARGE this payment produced.
 *
 * A separate write from `linkProviderObject` because the two ids become known
 * at different times: the payment exists the moment it is created, the charge
 * only once the payer has confirmed. Guarded on `provider_charge_id IS NULL`
 * for the same reason that one is guarded — a payment produces one charge, and
 * a second id arriving means either a retry that re-read the same value (in
 * which case nothing needs writing) or something this row cannot explain, which
 * must not be silently adopted.
 *
 * @returns `true` when this call did the linking.
 */
export async function linkProviderCharge(
  db: DatabaseOrTransaction,
  intentId: string,
  provider: ProviderId,
  providerChargeId: string,
): Promise<boolean> {
  const rows = await db
    .update(paymentIntents)
    .set({ providerChargeId })
    .where(
      and(
        eq(paymentIntents.id, intentId),
        eq(paymentIntents.provider, provider),
        isNull(paymentIntents.providerChargeId),
      ),
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
  providerObjectId: string,
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.provider, provider),
        eq(paymentIntents.providerObjectId, providerObjectId),
      ),
    );
  return row ? toIntentRow(row) : null;
}

/**
 * Which intent produced this CHARGE?
 *
 * The companion to `findIntentByProviderObject`, and a separate function
 * because it reads a different column: a provider event about a refund or a
 * dispute names the charge, not the payment, and matching a `ch_…` against
 * `provider_object_id` finds nothing — silently, as an `unmatched` event that
 * an operator eventually has to explain.
 *
 * `provider` is part of the key for the same reason it is there: object ids are
 * unique within one provider's numbering and nowhere else.
 */
export async function findIntentByProviderCharge(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerChargeId: string,
): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.provider, provider),
        eq(paymentIntents.providerChargeId, providerChargeId),
      ),
    );
  return row ? toIntentRow(row) : null;
}

/**
 * The statuses an unpaid intent may expire FROM (ADR 0012 D9, ADR 0019).
 *
 * What unites them is that the gateway is waiting on a PERSON: a FairCoin payer
 * who has not broadcast (`requires_action`), a card payer who has not supplied
 * or confirmed a payment method, or one who opened a 3DS challenge and walked
 * away. None of them has money moving anywhere, so a clock running out is the
 * honest outcome — a cancellation with `cancellation_reason: 'abandoned'`.
 *
 * `processing` is absent: on the chain coins are on their way and the
 * settlement watcher owns the row; on a card the acquirer is working on it.
 * `requires_capture` is absent because a held authorization is the merchant's
 * to capture or cancel.
 *
 * The list lives in `@peable.to/shared-types`, because the wire publishes it as
 * `PaymentIntent.can_expire`; the sweeper and the DTO read the same array.
 */
export const EXPIRABLE_STATUSES: readonly PaymentIntentStatus[] = SHARED_EXPIRABLE_STATUSES;

/**
 * The CARD intents whose expiry has passed — READ, not claimed.
 *
 * The one place in this file that deliberately does not claim what it returns,
 * and the reason is that a card intent cannot be expired by a local write
 * alone: the payment is still confirmable at the acquirer, so it has to be
 * cancelled THERE first (`services/cardCancellation.ts`), and only then can the
 * row move. A claim taken before that provider call would hold a row lock
 * across a network round trip, per row, for the length of the batch.
 *
 * Exclusivity moves to the compare-and-swap in `transitionIntent`: two sweepers
 * may both read the same row and both call cancel — which is idempotent given
 * the same key — and only one of them wins the write.
 *
 * `provider_object_id IS NOT NULL` is deliberately absent. An unlinked card
 * intent (a create interrupted between the row and the provider call) has
 * nothing to cancel, which `cancelCardPaymentAtProvider` answers
 * `nothing_to_cancel` for; excluding it here would leave it unexpirable
 * forever.
 */
export async function findDueCardIntents(
  db: DatabaseOrTransaction,
  now: Date,
  limit: number,
): Promise<PaymentIntentRow[]> {
  const rows = await db
    .select(INTENT_COLUMNS)
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.rail, 'card'),
        inArray(paymentIntents.status, [...EXPIRABLE_STATUSES]),
        lt(paymentIntents.expiresAt, now),
      ),
    )
    // Oldest first, like the claim below: a stream that expired its newest
    // arrivals first would starve its own head under a backlog.
    .orderBy(paymentIntents.expiresAt)
    .limit(limit);
  return rows.map(toIntentRow);
}

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
  limit: number,
): Promise<PaymentIntentRow[]> {
  const due = db
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        // CARD intents are excluded and swept separately, one at a time, by
        // `findDueCardIntents` above: their other half is a PaymentIntent at an
        // acquirer that stays confirmable, so expiring one with a local write
        // alone leaves a payment that can complete after the merchant has been
        // told it expired. The chain rail has no such half — a FairCoin payer
        // who did not broadcast has nothing anywhere — which is why the fast
        // set-based claim is still right for it.
        eq(paymentIntents.rail, 'faircoin'),
        inArray(paymentIntents.status, [...EXPIRABLE_STATUSES]),
        lt(paymentIntents.expiresAt, now),
      ),
    )
    // Oldest first: a stream that expired its newest arrivals first would
    // starve its own head under a backlog.
    .orderBy(paymentIntents.expiresAt)
    .limit(limit)
    .for('update', { skipLocked: true });

  // Expiry is a cancellation: `abandoned`, stamped now (ADR 0019).
  const rows = await db
    .update(paymentIntents)
    .set({
      status: 'canceled',
      cancellationReason: 'abandoned',
      canceledAt: sql`date_trunc('milliseconds', now())`,
      lastPaymentError: null,
    })
    .where(sql`${paymentIntents.id} in (${due})`)
    .returning(INTENT_COLUMNS);
  return rows.map(toIntentRow);
}

/**
 * Record the `pm_…` a SUCCEEDED card payment saved (`setup_future_usage`,
 * ADR 0016) — once: guarded on `payment_method_id IS NULL`, and never a status
 * write.
 */
export async function setIntentSavedPaymentMethod(
  db: DatabaseOrTransaction,
  id: string,
  paymentMethodId: string,
): Promise<boolean> {
  const rows = await db
    .update(paymentIntents)
    .set({ paymentMethodId })
    .where(
      and(
        eq(paymentIntents.id, id),
        eq(paymentIntents.rail, 'card'),
        isNull(paymentIntents.paymentMethodId),
      ),
    )
    .returning({ id: paymentIntents.id });
  return rows.length === 1;
}
