/**
 * Reads and writes for `connected_accounts`.
 *
 * Every write here is a SNAPSHOT write: the provider is the authority on
 * readiness and this table records what it said. There is deliberately no
 * function that sets a capability or a requirement count from anything but a
 * provider response — a hand-set readiness field is a seller the gateway
 * believes is payable on no evidence.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { connectedAccounts } from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import type { DatabaseOrTransaction } from '../postgres';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { ProviderId } from '../../services/providers/provider';
import type { AccountBusinessProfile, AccountSettings } from '@peable.to/shared-types';
import type { ConnectedAccountRole } from '../schema/valueSets';

/** Every seller lookup is scoped to sellers: the merchant's own account is not one. */
const IS_SELLER = eq(connectedAccounts.role, 'seller');

export type CapabilityStatus = 'active' | 'pending' | 'inactive';

export interface ConnectedAccountRow {
  /**
   * The mode this row lives in — its merchant's, read in the same statement
   * (`merchantLivemodeOf`, ADR 0017). Selects the provider key any operation on
   * it is sent with, and is what the wire calls `livemode`.
   */
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  /** The platform's own id for a SELLER; `null` on the merchant's own account (ADR 0015 §1). */
  readonly externalRef: string | null;
  readonly role: ConnectedAccountRole;
  /** The CARD half. All three are `null` together on a FairCoin-only seller (ADR 0012 D1). */
  readonly provider: ProviderId | null;
  /** NEVER on a DTO — ADR 0001 D3. The `acct_…` is the gateway's business. */
  readonly providerAccountId: string | null;
  readonly country: string | null;
  readonly defaultCurrency: string | null;
  readonly payoutsEnabled: boolean;
  readonly chargesEnabled: boolean;
  readonly transfersCapability: CapabilityStatus | null;
  readonly cardPaymentsCapability: CapabilityStatus | null;
  readonly currentlyDue: readonly string[];
  readonly eventuallyDue: readonly string[];
  readonly pastDue: readonly string[];
  readonly pendingVerification: readonly string[];
  readonly disabledReasonCodes: readonly string[];
  /** The provider's business profile and settings; `null` before a read carried them. */
  readonly businessProfile: AccountBusinessProfile | null;
  readonly settings: AccountSettings | null;
  /** The ledger's ingestion cursor (ADR 0015 §4). */
  readonly balanceSyncedThrough: Date | null;
  readonly lastSyncedAt: Date | null;
  /**
   * The FAIRCOIN half (ADR 0012). `network` and `faircoinOxyUserId` are set
   * together when the platform opens it; `faircoinRegisteredAt` when the seller
   * registers their key. The key itself is deliberately NOT on this row type —
   * it is a protected column, read only by the reservation and the writer.
   */
  readonly network: NetworkType | null;
  readonly faircoinOxyUserId: string | null;
  readonly faircoinRegisteredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The card half, narrowed — what every card path needs and a FairCoin-only row lacks. */
export type CardConnectedAccountRow = ConnectedAccountRow & {
  readonly provider: ProviderId;
  readonly providerAccountId: string;
  readonly country: string;
};

/** Whether this seller has a card half at all. */
export function hasCardHalf(row: ConnectedAccountRow): row is CardConnectedAccountRow {
  return row.provider !== null && row.providerAccountId !== null && row.country !== null;
}

/** Where a seller's FairCoin half stands — `null` when the platform never opened one. */
export type FaircoinHalfStatus = 'pending' | 'active';

export function faircoinStatusOf(row: ConnectedAccountRow): FaircoinHalfStatus | null {
  if (row.network === null) return null;
  return row.faircoinRegisteredAt === null ? 'pending' : 'active';
}

const ACCOUNT_COLUMNS = {
  livemode: merchantLivemodeOf(connectedAccounts.merchantId),
  id: connectedAccounts.id,
  publicId: connectedAccounts.publicId,
  merchantId: connectedAccounts.merchantId,
  externalRef: connectedAccounts.externalRef,
  role: connectedAccounts.role,
  provider: connectedAccounts.provider,
  providerAccountId: connectedAccounts.providerAccountId,
  country: connectedAccounts.country,
  defaultCurrency: connectedAccounts.defaultCurrency,
  payoutsEnabled: connectedAccounts.payoutsEnabled,
  chargesEnabled: connectedAccounts.chargesEnabled,
  transfersCapability: connectedAccounts.transfersCapability,
  cardPaymentsCapability: connectedAccounts.cardPaymentsCapability,
  currentlyDue: connectedAccounts.currentlyDue,
  eventuallyDue: connectedAccounts.eventuallyDue,
  pastDue: connectedAccounts.pastDue,
  pendingVerification: connectedAccounts.pendingVerification,
  disabledReasonCodes: connectedAccounts.disabledReasonCodes,
  businessProfile: connectedAccounts.businessProfile,
  settings: connectedAccounts.settings,
  balanceSyncedThrough: connectedAccounts.balanceSyncedThrough,
  lastSyncedAt: connectedAccounts.lastSyncedAt,
  network: connectedAccounts.network,
  faircoinOxyUserId: connectedAccounts.faircoinOxyUserId,
  faircoinRegisteredAt: connectedAccounts.faircoinRegisteredAt,
  createdAt: connectedAccounts.createdAt,
  updatedAt: connectedAccounts.updatedAt,
} as const;

function toRow(row: Record<string, unknown>): ConnectedAccountRow {
  return row as unknown as ConnectedAccountRow;
}

/** The card half as the create path writes it — read off a provider response, never a request. */
export interface CardHalfParams {
  readonly provider: ProviderId;
  readonly providerAccountId: string;
  readonly country: string;
}

/** The FairCoin half as the PLATFORM opens it. The key is the seller's, and arrives later. */
export interface FaircoinHalfParams {
  readonly network: NetworkType;
  readonly oxyUserId: string;
}

/**
 * At least one half; the type says so, and `connected_accounts_has_a_rail_check`
 * says it again. The card half stays FLAT — the shape every card caller wrote
 * before ADR 0012 — so a card seller is created exactly as it always was.
 */
export type InsertConnectedAccountParams = {
  readonly publicId: string;
  readonly merchantId: string;
  readonly externalRef: string;
} & (
  | (CardHalfParams & { readonly faircoin?: FaircoinHalfParams })
  | {
      readonly provider?: undefined;
      readonly providerAccountId?: undefined;
      readonly country?: undefined;
      readonly faircoin: FaircoinHalfParams;
    }
);

/**
 * Record an account this gateway has just opened at the provider.
 *
 * @returns the row, or `null` when `(merchant_id, external_ref)` already
 *   exists — a concurrent second "open the account for store 42". The caller
 *   re-reads the winner. Converging on the index rather than reading first is
 *   what stops a race opening TWO real accounts at the provider, which is not
 *   an error that can be undone: an account cannot be deleted, and the seller
 *   is left with one nobody uses.
 *
 * No readiness fields are accepted. They arrive only from `applyAccountSnapshot`.
 * No confirmation either: only the seller confirms the FairCoin half, from
 * their own session (`confirmFaircoinHalf`, ADR 0012 D3).
 */
export async function insertConnectedAccount(
  db: DatabaseOrTransaction,
  params: InsertConnectedAccountParams,
): Promise<ConnectedAccountRow | null> {
  try {
    const [row] = await db
      .insert(connectedAccounts)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        externalRef: params.externalRef,
        provider: params.provider ?? null,
        providerAccountId: params.providerAccountId ?? null,
        country: params.country ?? null,
        network: params.faircoin?.network ?? null,
        faircoinOxyUserId: params.faircoin?.oxyUserId ?? null,
      })
      .returning(ACCOUNT_COLUMNS);
    return row ? toRow(row) : null;
  } catch (error) {
    if (isUniqueViolation(error, 'connected_accounts_merchant_external_ref_key')) {
      return null;
    }
    throw error;
  }
}

/**
 * Give an existing FairCoin-only seller a CARD half — the account the gateway
 * has just opened at the provider for them.
 *
 * `WHERE provider IS NULL` is the convergence: two concurrent "add cards for
 * store 42" both opened the SAME provider account (the idempotency key is
 * derived from the seller, not random), and only one of them writes it. The
 * loser re-reads.
 *
 * @returns the row, or `null` when the row already had a card half.
 */
export async function attachCardHalf(
  db: DatabaseOrTransaction,
  accountId: string,
  card: CardHalfParams,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({
      provider: card.provider,
      providerAccountId: card.providerAccountId,
      country: card.country,
    })
    .where(and(eq(connectedAccounts.id, accountId), isNull(connectedAccounts.provider)))
    .returning(ACCOUNT_COLUMNS);
  return row ? toRow(row) : null;
}

/**
 * Open the FairCoin half on an existing (card) seller.
 *
 * `WHERE network IS NULL`, so a half already opened is never re-pointed at
 * another network or another Oxy user — the caller reads the row back and
 * decides whether what is there agrees with what was asked.
 *
 * @returns the row, or `null` when the half was already open.
 */
export async function enableFaircoinHalf(
  db: DatabaseOrTransaction,
  accountId: string,
  faircoin: FaircoinHalfParams,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({ network: faircoin.network, faircoinOxyUserId: faircoin.oxyUserId })
    .where(and(eq(connectedAccounts.id, accountId), isNull(connectedAccounts.network)))
    .returning(ACCOUNT_COLUMNS);
  return row ? toRow(row) : null;
}

/** Why a seller's FairCoin half was not confirmed. Every case is a refusal, never a partial write. */
export type ConfirmFaircoinRefusal =
  /** The half was never opened, or the row does not exist. */
  | 'no_faircoin_half'
  /** The seller already confirmed it. */
  | 'already_registered';

export type ConfirmFaircoinResult =
  | { readonly ok: true; readonly account: ConnectedAccountRow }
  | { readonly ok: false; readonly refusal: ConfirmFaircoinRefusal };

/**
 * The SELLER confirms their FairCoin half (ADR 0012 D3, ADR 0021 D5): the one
 * writer of `faircoin_registered_at`. No key is stored — payments go to the
 * Peable wallet of the seller's own Oxy account (`faircoin_oxy_user_id`),
 * derived from its public identity key. One conditional UPDATE: a second
 * confirmation changes nothing.
 */
export async function confirmFaircoinHalf(
  db: DatabaseOrTransaction,
  accountId: string,
  now: Date = new Date(),
): Promise<ConfirmFaircoinResult> {
  const [row] = await db
    .update(connectedAccounts)
    .set({ faircoinRegisteredAt: now })
    .where(
      and(
        eq(connectedAccounts.id, accountId),
        isNull(connectedAccounts.faircoinRegisteredAt),
        isNotNull(connectedAccounts.network),
      ),
    )
    .returning(ACCOUNT_COLUMNS);
  if (row) return { ok: true, account: toRow(row) };
  const [current] = await db
    .select({ network: connectedAccounts.network })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, accountId));
  return {
    ok: false,
    refusal: !current || current.network === null ? 'no_faircoin_half' : 'already_registered',
  };
}

/** The merchant's own address for a seller — the lookup every API call makes. */
export async function findAccountByExternalRef(
  db: DatabaseOrTransaction,
  merchantId: string,
  externalRef: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.merchantId, merchantId),
        eq(connectedAccounts.externalRef, externalRef),
      ),
    );
  return row ? toRow(row) : null;
}

/**
 * By `ca_…`, SCOPED TO THE MERCHANT.
 *
 * The merchant id is a parameter rather than something the caller filters
 * afterwards, because forgetting the filter is how one merchant reads another's
 * seller — and a `ca_…` is guessable enough that "it is unlisted" is not an
 * access control.
 */
export async function findAccountByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.merchantId, merchantId),
        eq(connectedAccounts.publicId, publicId),
        IS_SELLER,
      ),
    );
  return row ? toRow(row) : null;
}

/**
 * The merchant's OWN fiat account (ADR 0015 §1), or `null` when it has none.
 * At most one: `connected_accounts_merchant_role_key`.
 */
export async function findMerchantAccount(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(eq(connectedAccounts.merchantId, merchantId), eq(connectedAccounts.role, 'merchant')),
    );
  return row ? toRow(row) : null;
}

/**
 * Record the merchant's own account, just opened at the provider.
 *
 * @returns the row, or `null` when the merchant already has one — a concurrent
 *   open that presented the SAME provider idempotency key, so the winner's
 *   account is the same account. The caller re-reads it.
 */
export async function insertMerchantAccount(
  db: DatabaseOrTransaction,
  params: { publicId: string; merchantId: string } & CardHalfParams,
): Promise<ConnectedAccountRow | null> {
  try {
    const [row] = await db
      .insert(connectedAccounts)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        externalRef: null,
        role: 'merchant',
        provider: params.provider,
        providerAccountId: params.providerAccountId,
        country: params.country,
      })
      .returning(ACCOUNT_COLUMNS);
    return row ? toRow(row) : null;
  } catch (error) {
    if (isUniqueViolation(error, 'connected_accounts_merchant_role_key')) return null;
    throw error;
  }
}

/** Advance the ledger cursor; never backwards. */
export async function advanceBalanceCursor(
  db: DatabaseOrTransaction,
  accountId: string,
  through: Date,
): Promise<void> {
  await db
    .update(connectedAccounts)
    .set({
      balanceSyncedThrough: sql`greatest(coalesce(${connectedAccounts.balanceSyncedThrough}, ${through.toISOString()}::timestamptz), ${through.toISOString()}::timestamptz)`,
    })
    .where(eq(connectedAccounts.id, accountId));
}

/**
 * Every account with a card half in the modes given — the reconciliation
 * job's walk. Not scoped to a merchant: it is a background loop.
 */
export async function findCardAccounts(
  db: DatabaseOrTransaction,
  livemodes: readonly boolean[],
): Promise<readonly ConnectedAccountRow[]> {
  if (livemodes.length === 0) return [];
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        isNotNull(connectedAccounts.provider),
        inArray(merchantLivemodeOf(connectedAccounts.merchantId), [...livemodes]),
      ),
    )
    .orderBy(asc(connectedAccounts.createdAt));
  return rows.map(toRow);
}

/**
 * By INTERNAL id, scoped to the merchant.
 *
 * What a serializer needs: `transfers` stores the account's primary key, and
 * the wire contract promises a `ca_…`. Resolving it here rather than joining in
 * every read keeps that one translation in one place.
 */
export async function findAccountById(
  db: DatabaseOrTransaction,
  merchantId: string,
  id: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.merchantId, merchantId), eq(connectedAccounts.id, id)));
  return row ? toRow(row) : null;
}

/**
 * By INTERNAL id and NOT scoped to a merchant — for the seller-facing
 * onboarding path ONLY (ADR 0012 D3).
 *
 * That path has no merchant credential: its authority is a valid onboarding
 * link plus the seller's own Oxy session, and the link names the account by
 * this id. Like `findAccountByProviderAccountId`, a caller must not use it to
 * answer a merchant's request.
 */
export async function findAccountForOnboarding(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, id));
  return row ? toRow(row) : null;
}

/**
 * "Which seller is this?" — where every inbound account event starts.
 *
 * NOT scoped to a merchant: a provider event names an account and nothing else,
 * and the whole point of this lookup is to discover which merchant it belongs
 * to. The caller must not then use it to answer a merchant's request.
 */
export async function findAccountByProviderAccountId(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerAccountId: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.provider, provider),
        eq(connectedAccounts.providerAccountId, providerAccountId),
      ),
    );
  return row ? toRow(row) : null;
}

/** What a provider read reports. Every field is the provider's, none is ours. */
export interface AccountSnapshot {
  readonly payoutsEnabled: boolean;
  readonly chargesEnabled: boolean;
  readonly transfersCapability: CapabilityStatus | null;
  readonly cardPaymentsCapability: CapabilityStatus | null;
  readonly currentlyDue: readonly string[];
  readonly eventuallyDue: readonly string[];
  readonly pastDue: readonly string[];
  readonly pendingVerification: readonly string[];
  readonly disabledReasonCodes: readonly string[];
  readonly defaultCurrency: string | null;
  readonly businessProfile: AccountBusinessProfile;
  readonly settings: AccountSettings;
}

/**
 * Overwrite the readiness fields from a provider read, and stamp the sync.
 *
 * A full overwrite, never a merge: a requirement that has been SATISFIED
 * disappears from the provider's response, and merging would leave it standing
 * forever — a seller told to do something they already did, with no way to
 * clear it.
 */
/**
 * Exactly the columns a provider snapshot writes — no more, no fewer.
 *
 * `applyAccountSnapshot`'s `.set()` is checked against this with `satisfies`,
 * which is total in both directions: a field named here and missing from the
 * write fails, and a field written and missing here fails too.
 *
 * It exists so `readinessChanged` can be pinned to the same set. That function
 * decides whether a merchant is TOLD about a change, it was written as a
 * hand-kept list of comparisons, and it had already fallen one behind — it
 * omitted `defaultCurrency`, so an account whose payout currency changed
 * updated silently and the marketplace settling into it would have found out
 * from a transfer in the wrong currency. Adding a column to the write now
 * forces a decision there rather than defaulting to silence.
 */
export type SnapshotWrittenField =
  | 'payoutsEnabled'
  | 'chargesEnabled'
  | 'transfersCapability'
  | 'cardPaymentsCapability'
  | 'currentlyDue'
  | 'eventuallyDue'
  | 'pastDue'
  | 'pendingVerification'
  | 'disabledReasonCodes'
  | 'defaultCurrency'
  | 'businessProfile'
  | 'settings'
  | 'lastSyncedAt';

export async function applyAccountSnapshot(
  db: DatabaseOrTransaction,
  accountId: string,
  snapshot: AccountSnapshot,
  now: Date = new Date(),
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({
      payoutsEnabled: snapshot.payoutsEnabled,
      chargesEnabled: snapshot.chargesEnabled,
      transfersCapability: snapshot.transfersCapability,
      cardPaymentsCapability: snapshot.cardPaymentsCapability,
      currentlyDue: [...snapshot.currentlyDue],
      eventuallyDue: [...snapshot.eventuallyDue],
      pastDue: [...snapshot.pastDue],
      pendingVerification: [...snapshot.pendingVerification],
      businessProfile: snapshot.businessProfile,
      settings: snapshot.settings,
      // Empty codes are filtered here rather than left to the CHECK: a provider
      // sending one is not a bug worth failing a whole sync over, and the row is
      // more useful with the rest of the codes than refused for one blank.
      disabledReasonCodes: snapshot.disabledReasonCodes.filter((code) => code.length > 0),
      defaultCurrency: snapshot.defaultCurrency,
      lastSyncedAt: now,
    } satisfies Record<SnapshotWrittenField, unknown>)
    .where(eq(connectedAccounts.id, accountId))
    .returning(ACCOUNT_COLUMNS);
  return row ? toRow(row) : null;
}

/**
 * The sync sweep's batch: least-recently-synced first, never-synced ahead of
 * everything.
 *
 * `NULLS FIRST` is explicit and load-bearing. PostgreSQL's default for `ASC` is
 * `NULLS LAST`, which would put the accounts that have NEVER been synced — the
 * ones that most need it, because nothing is known about them at all — at the
 * very back of the queue, behind every account already known to be fine.
 */
export async function findAccountsToSync(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  limit: number,
  /**
   * The modes this deployment can read accounts in (ADR 0017), as `livemode`
   * values. An account of a mode with no key is left out rather than read and
   * refused: at the front of the queue it would stop every pass before the
   * accounts of the mode that IS configured were reached.
   */
  livemodes: readonly boolean[],
): Promise<readonly ConnectedAccountRow[]> {
  if (livemodes.length === 0) return [];
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.provider, provider),
        inArray(merchantLivemodeOf(connectedAccounts.merchantId), [...livemodes]),
      ),
    )
    .orderBy(
      sql`${connectedAccounts.lastSyncedAt} asc nulls first`,
      asc(connectedAccounts.createdAt),
    )
    .limit(limit);
  return rows.map(toRow);
}

/**
 * One PAGE of a merchant's sellers, newest first.
 *
 * This used to take a bare `limit` and return whatever fitted, with no cursor
 * and no `has_more`: a marketplace with more than a hundred sellers could not
 * see the rest of them, and nothing in the response said so. A silently
 * truncated list is worse than a refusal — a caller reconciling against it
 * concludes the sellers are gone. The walk is `db/keyset.ts`'s, on the primary
 * key, for the reason every list's is.
 */
export async function listAccountsForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
  page: KeysetPage,
): Promise<{ data: ConnectedAccountRow[]; hasMore: boolean }> {
  const walk = keyset(connectedAccounts.id, connectedAccounts.createdAt, page);
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.merchantId, merchantId), IS_SELLER, walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

/**
 * Several sellers by PUBLIC id, scoped to the merchant in the predicate — the
 * `expand[]` loader, one query per page.
 */
export async function findAccountsByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<ConnectedAccountRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.merchantId, merchantId),
        inArray(connectedAccounts.publicId, [...publicIds]),
        IS_SELLER,
      ),
    );
  return rows.map(toRow);
}
