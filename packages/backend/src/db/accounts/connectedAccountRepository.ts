/**
 * Reads and writes for `connected_accounts`.
 *
 * Every write here is a SNAPSHOT write: the provider is the authority on
 * readiness and this table records what it said. There is deliberately no
 * function that sets a capability or a requirement count from anything but a
 * provider response — a hand-set readiness field is a seller the gateway
 * believes is payable on no evidence.
 */
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { connectedAccounts } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import type { ProviderId } from '../../services/providers/provider';

export type CapabilityStatus = 'active' | 'pending' | 'inactive';

export interface ConnectedAccountRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly externalRef: string;
  readonly provider: ProviderId;
  /** NEVER on a DTO — ADR 0001 D3. The `acct_…` is the gateway's business. */
  readonly providerAccountId: string;
  readonly country: string;
  readonly defaultCurrency: string | null;
  readonly payoutsEnabled: boolean;
  readonly chargesEnabled: boolean;
  readonly transfersCapability: CapabilityStatus | null;
  readonly cardPaymentsCapability: CapabilityStatus | null;
  readonly requirementsCurrentlyDue: number;
  readonly requirementsEventuallyDue: number;
  readonly requirementsPastDue: number;
  readonly requirementsPendingVerification: number;
  readonly disabledReasonCodes: readonly string[];
  readonly lastSyncedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const ACCOUNT_COLUMNS = {
  id: connectedAccounts.id,
  publicId: connectedAccounts.publicId,
  merchantId: connectedAccounts.merchantId,
  externalRef: connectedAccounts.externalRef,
  provider: connectedAccounts.provider,
  providerAccountId: connectedAccounts.providerAccountId,
  country: connectedAccounts.country,
  defaultCurrency: connectedAccounts.defaultCurrency,
  payoutsEnabled: connectedAccounts.payoutsEnabled,
  chargesEnabled: connectedAccounts.chargesEnabled,
  transfersCapability: connectedAccounts.transfersCapability,
  cardPaymentsCapability: connectedAccounts.cardPaymentsCapability,
  requirementsCurrentlyDue: connectedAccounts.requirementsCurrentlyDue,
  requirementsEventuallyDue: connectedAccounts.requirementsEventuallyDue,
  requirementsPastDue: connectedAccounts.requirementsPastDue,
  requirementsPendingVerification: connectedAccounts.requirementsPendingVerification,
  disabledReasonCodes: connectedAccounts.disabledReasonCodes,
  lastSyncedAt: connectedAccounts.lastSyncedAt,
  createdAt: connectedAccounts.createdAt,
  updatedAt: connectedAccounts.updatedAt,
} as const;

function toRow(row: Record<string, unknown>): ConnectedAccountRow {
  return row as unknown as ConnectedAccountRow;
}

export interface InsertConnectedAccountParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly externalRef: string;
  readonly provider: ProviderId;
  readonly providerAccountId: string;
  readonly country: string;
}

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
 */
export async function insertConnectedAccount(
  db: DatabaseOrTransaction,
  params: InsertConnectedAccountParams
): Promise<ConnectedAccountRow | null> {
  try {
    const [row] = await db
      .insert(connectedAccounts)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        externalRef: params.externalRef,
        provider: params.provider,
        providerAccountId: params.providerAccountId,
        country: params.country,
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

/** The merchant's own address for a seller — the lookup every API call makes. */
export async function findAccountByExternalRef(
  db: DatabaseOrTransaction,
  merchantId: string,
  externalRef: string
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.merchantId, merchantId),
        eq(connectedAccounts.externalRef, externalRef)
      )
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
  publicId: string
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.merchantId, merchantId),
        eq(connectedAccounts.publicId, publicId)
      )
    );
  return row ? toRow(row) : null;
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
  id: string
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.merchantId, merchantId), eq(connectedAccounts.id, id)));
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
  providerAccountId: string
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.provider, provider),
        eq(connectedAccounts.providerAccountId, providerAccountId)
      )
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
  | 'requirementsCurrentlyDue'
  | 'requirementsEventuallyDue'
  | 'requirementsPastDue'
  | 'requirementsPendingVerification'
  | 'disabledReasonCodes'
  | 'defaultCurrency'
  | 'lastSyncedAt';

export async function applyAccountSnapshot(
  db: DatabaseOrTransaction,
  accountId: string,
  snapshot: AccountSnapshot,
  now: Date = new Date()
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({
      payoutsEnabled: snapshot.payoutsEnabled,
      chargesEnabled: snapshot.chargesEnabled,
      transfersCapability: snapshot.transfersCapability,
      cardPaymentsCapability: snapshot.cardPaymentsCapability,
      requirementsCurrentlyDue: snapshot.currentlyDue.length,
      requirementsEventuallyDue: snapshot.eventuallyDue.length,
      requirementsPastDue: snapshot.pastDue.length,
      requirementsPendingVerification: snapshot.pendingVerification.length,
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
  limit: number
): Promise<readonly ConnectedAccountRow[]> {
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(eq(connectedAccounts.provider, provider))
    .orderBy(sql`${connectedAccounts.lastSyncedAt} asc nulls first`, asc(connectedAccounts.createdAt))
    .limit(limit);
  return rows.map(toRow);
}

/** Every seller a merchant has onboarded. Newest first. */
export interface ListAccountsPage {
  readonly data: readonly ConnectedAccountRow[];
  /** Whether another page exists — the cursor to continue from is the last row's `ca_…`. */
  readonly hasMore: boolean;
}

/**
 * One PAGE of a merchant's sellers, newest first.
 *
 * This used to take a bare `limit` and return whatever fitted, with no cursor
 * and no `has_more`: a marketplace with more than a hundred sellers could not
 * see the rest of them, and nothing in the response said so. A silently
 * truncated list is worse than a refusal — a caller reconciling against it
 * concludes the sellers are gone.
 *
 * The keyset walk runs on the PRIMARY KEY rather than on `created_at`. Both are
 * uuidv7 and therefore k-sortable, so the order is the same, and `id` is unique
 * where a timestamp is not: two accounts created in the same millisecond would
 * make a `created_at` cursor either skip one or repeat it forever.
 *
 * `limit + 1` rows are read and the extra is dropped, which answers `has_more`
 * without a second `count(*)` over a table that grows with the merchant.
 */
export async function listAccountsForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
  limit: number,
  after?: string
): Promise<ListAccountsPage> {
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.merchantId, merchantId),
        after === undefined ? undefined : lt(connectedAccounts.id, after)
      )
    )
    .orderBy(desc(connectedAccounts.id))
    .limit(limit + 1);

  return {
    data: rows.slice(0, limit).map(toRow),
    hasMore: rows.length > limit,
  };
}
