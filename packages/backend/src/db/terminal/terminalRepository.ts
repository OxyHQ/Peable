import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import type {
  Address,
  TerminalReaderActionStatus,
  TerminalReaderStatus,
} from '@peable.to/shared-types';
import { terminalLocations, terminalReaders } from '../schema';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import type { ProviderId } from '../../services/providers/provider';

/**
 * Reads and writes for `terminal_locations` and `terminal_readers` (ADR 0024).
 *
 * A reader's action moves only by compare-and-swap: {@link claimReaderAction}
 * starts one (Orbit is about to ask the provider), {@link acknowledgeReaderAction}
 * records that the provider took it, and {@link settleReaderAction} writes the
 * outcome the provider's reader read reports — each guarded on the action it
 * was decided from, so two readers of the provider can never write an outcome
 * twice or over a newer attempt.
 */

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface TerminalLocationRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly displayName: string;
  readonly address: Address;
  readonly metadata: Record<string, string>;
  readonly provider: ProviderId;
  readonly providerObjectId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const LOCATION_COLUMNS = {
  livemode: merchantLivemodeOf(terminalLocations.merchantId),
  id: terminalLocations.id,
  publicId: terminalLocations.publicId,
  merchantId: terminalLocations.merchantId,
  displayName: terminalLocations.displayName,
  address: terminalLocations.address,
  metadata: terminalLocations.metadata,
  provider: terminalLocations.provider,
  providerObjectId: terminalLocations.providerObjectId,
  createdAt: terminalLocations.createdAt,
  updatedAt: terminalLocations.updatedAt,
} as const;

const toLocationRow = (row: unknown): TerminalLocationRow => row as TerminalLocationRow;

export async function insertTerminalLocation(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly displayName: string;
    readonly address: Address;
    readonly metadata: Record<string, string>;
    readonly provider: ProviderId;
    readonly providerObjectId: string;
  },
): Promise<TerminalLocationRow> {
  const [row] = await db
    .insert(terminalLocations)
    .values({ id: uuidv7(), ...params })
    .returning(LOCATION_COLUMNS);
  if (!row) throw new Error(`terminal location ${params.publicId} was not inserted`);
  return toLocationRow(row);
}

/** `tml_…` scoped to the merchant in the predicate. */
export async function findTerminalLocationForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<TerminalLocationRow | null> {
  const [row] = await db
    .select(LOCATION_COLUMNS)
    .from(terminalLocations)
    .where(
      and(eq(terminalLocations.publicId, publicId), eq(terminalLocations.merchantId, merchantId)),
    );
  return row ? toLocationRow(row) : null;
}

export async function findTerminalLocationById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<TerminalLocationRow | null> {
  const [row] = await db
    .select(LOCATION_COLUMNS)
    .from(terminalLocations)
    .where(eq(terminalLocations.id, id));
  return row ? toLocationRow(row) : null;
}

export async function listTerminalLocationsForMerchant(
  db: DatabaseOrTransaction,
  params: { readonly merchantId: string; readonly page: KeysetPage },
): Promise<{ data: TerminalLocationRow[]; hasMore: boolean }> {
  const walk = keyset(terminalLocations.id, terminalLocations.createdAt, params.page);
  const rows = await db
    .select(LOCATION_COLUMNS)
    .from(terminalLocations)
    .where(and(eq(terminalLocations.merchantId, params.merchantId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toLocationRow));
}

/** The merchant's locations among these `tml_…` (an expansion's loader). */
export async function findTerminalLocationsForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<TerminalLocationRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(LOCATION_COLUMNS)
    .from(terminalLocations)
    .where(
      and(
        eq(terminalLocations.merchantId, merchantId),
        inArray(terminalLocations.publicId, [...publicIds]),
      ),
    );
  return rows.map(toLocationRow);
}

/**
 * Write what the provider accepted (name, address) and the merchant's
 * metadata patch. `limit_exceeded` when the merged metadata would hold too
 * many keys; `null` when the row is gone.
 */
export async function updateTerminalLocation(
  db: DatabaseOrTransaction,
  id: string,
  patch: {
    readonly displayName?: string | undefined;
    readonly address?: Address | undefined;
    readonly metadata?: MetadataPatch | undefined;
  },
): Promise<TerminalLocationRow | 'limit_exceeded' | null> {
  const merged =
    patch.metadata === undefined
      ? undefined
      : mergedMetadata(terminalLocations.metadata, patch.metadata);
  const [row] = await db
    .update(terminalLocations)
    .set({
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.address !== undefined ? { address: patch.address } : {}),
      ...(merged !== undefined ? { metadata: merged } : {}),
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(
      and(
        eq(terminalLocations.id, id),
        merged === undefined ? undefined : metadataWithinLimit(merged),
      ),
    )
    .returning(LOCATION_COLUMNS);
  if (row) return toLocationRow(row);
  return (await findTerminalLocationById(db, id)) ? 'limit_exceeded' : null;
}

/** Whether any reader is registered to the location. */
export async function locationHasReaders(
  db: DatabaseOrTransaction,
  locationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: terminalReaders.id })
    .from(terminalReaders)
    .where(eq(terminalReaders.locationId, locationId))
    .limit(1);
  return row !== undefined;
}

/**
 * Delete a location with no readers, in ONE statement: a reader registered
 * between the caller's check and this write makes it `in_use` rather than a
 * foreign-key failure.
 */
export async function deleteTerminalLocation(
  db: DatabaseOrTransaction,
  id: string,
): Promise<'deleted' | 'in_use' | 'missing'> {
  const rows = await db
    .delete(terminalLocations)
    .where(
      and(
        eq(terminalLocations.id, id),
        sql`not exists (select 1 from ${terminalReaders} where ${terminalReaders.locationId} = ${terminalLocations.id})`,
      ),
    )
    .returning({ id: terminalLocations.id });
  if (rows.length === 1) return 'deleted';
  return (await findTerminalLocationById(db, id)) ? 'in_use' : 'missing';
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export interface TerminalReaderActionRow {
  readonly type: 'process_payment_intent';
  readonly status: TerminalReaderActionStatus;
  /** The internal id of the PaymentIntent being collected. */
  readonly paymentIntentId: string;
  readonly paymentIntentPublicId: string;
  readonly enableCustomerCancellation: boolean;
  readonly failureCode: string | null;
  readonly startedAt: Date;
  readonly acknowledgedAt: Date | null;
}

export interface TerminalReaderRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly locationId: string;
  readonly locationPublicId: string;
  readonly label: string;
  readonly deviceType: string;
  readonly serialNumber: string;
  readonly status: TerminalReaderStatus | null;
  readonly lastSeenAt: Date | null;
  readonly metadata: Record<string, string>;
  readonly action: TerminalReaderActionRow | null;
  readonly provider: ProviderId;
  readonly providerObjectId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const READER_COLUMNS = {
  livemode: merchantLivemodeOf(terminalReaders.merchantId),
  id: terminalReaders.id,
  publicId: terminalReaders.publicId,
  merchantId: terminalReaders.merchantId,
  locationId: terminalReaders.locationId,
  // Scalar subqueries rather than joins: these columns are also every
  // INSERT/UPDATE … RETURNING, and RETURNING cannot join.
  locationPublicId: sql<string>`(select tl.public_id from terminal_locations tl where tl.id = "terminal_readers"."location_id")`,
  label: terminalReaders.label,
  deviceType: terminalReaders.deviceType,
  serialNumber: terminalReaders.serialNumber,
  status: terminalReaders.status,
  lastSeenAt: terminalReaders.lastSeenAt,
  metadata: terminalReaders.metadata,
  actionType: terminalReaders.actionType,
  actionStatus: terminalReaders.actionStatus,
  actionPaymentIntentId: terminalReaders.actionPaymentIntentId,
  actionPaymentIntentPublicId: sql<
    string | null
  >`(select pi.public_id from payment_intents pi where pi.id = "terminal_readers"."action_payment_intent_id")`,
  actionEnableCustomerCancellation: terminalReaders.actionEnableCustomerCancellation,
  actionFailureCode: terminalReaders.actionFailureCode,
  actionStartedAt: terminalReaders.actionStartedAt,
  actionAcknowledgedAt: terminalReaders.actionAcknowledgedAt,
  provider: terminalReaders.provider,
  providerObjectId: terminalReaders.providerObjectId,
  createdAt: terminalReaders.createdAt,
  updatedAt: terminalReaders.updatedAt,
} as const;

interface RawReader {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly locationId: string;
  readonly locationPublicId: string;
  readonly label: string;
  readonly deviceType: string;
  readonly serialNumber: string;
  readonly status: string | null;
  readonly lastSeenAt: Date | null;
  readonly metadata: Record<string, string>;
  readonly actionType: string | null;
  readonly actionStatus: string | null;
  readonly actionPaymentIntentId: string | null;
  readonly actionPaymentIntentPublicId: string | null;
  readonly actionEnableCustomerCancellation: boolean | null;
  readonly actionFailureCode: string | null;
  readonly actionStartedAt: Date | null;
  readonly actionAcknowledgedAt: Date | null;
  readonly provider: string;
  readonly providerObjectId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toReaderRow(raw: RawReader): TerminalReaderRow {
  const {
    actionType,
    actionStatus,
    actionPaymentIntentId,
    actionPaymentIntentPublicId,
    actionEnableCustomerCancellation,
    actionFailureCode,
    actionStartedAt,
    actionAcknowledgedAt,
    ...rest
  } = raw;
  // The CHECK makes an action whole or absent; the casts are the CHECK's sets.
  const action: TerminalReaderActionRow | null =
    actionType !== null &&
    actionStatus !== null &&
    actionPaymentIntentId !== null &&
    actionStartedAt !== null
      ? {
          type: 'process_payment_intent',
          status: actionStatus as TerminalReaderActionStatus,
          paymentIntentId: actionPaymentIntentId,
          paymentIntentPublicId: actionPaymentIntentPublicId ?? '',
          enableCustomerCancellation: actionEnableCustomerCancellation ?? false,
          failureCode: actionFailureCode,
          startedAt: actionStartedAt,
          acknowledgedAt: actionAcknowledgedAt,
        }
      : null;
  return {
    ...rest,
    status: rest.status as TerminalReaderStatus | null,
    provider: rest.provider as ProviderId,
    action,
  };
}

export async function insertTerminalReader(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly locationId: string;
    readonly label: string;
    readonly deviceType: string;
    readonly serialNumber: string;
    readonly status: TerminalReaderStatus | null;
    readonly lastSeenAt: Date | null;
    readonly metadata: Record<string, string>;
    readonly provider: ProviderId;
    readonly providerObjectId: string;
  },
): Promise<TerminalReaderRow> {
  const [row] = await db
    .insert(terminalReaders)
    .values({ id: uuidv7(), ...params })
    .returning(READER_COLUMNS);
  if (!row) throw new Error(`terminal reader ${params.publicId} was not inserted`);
  return toReaderRow(row as RawReader);
}

/** `tmr_…` scoped to the merchant in the predicate. */
export async function findTerminalReaderForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<TerminalReaderRow | null> {
  const [row] = await db
    .select(READER_COLUMNS)
    .from(terminalReaders)
    .where(and(eq(terminalReaders.publicId, publicId), eq(terminalReaders.merchantId, merchantId)));
  return row ? toReaderRow(row as RawReader) : null;
}

export async function findTerminalReaderById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<TerminalReaderRow | null> {
  const [row] = await db
    .select(READER_COLUMNS)
    .from(terminalReaders)
    .where(eq(terminalReaders.id, id));
  return row ? toReaderRow(row as RawReader) : null;
}

/** The drain's lookup: which reader is this provider object? */
export async function findTerminalReaderByProviderObject(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerObjectId: string,
): Promise<TerminalReaderRow | null> {
  const [row] = await db
    .select(READER_COLUMNS)
    .from(terminalReaders)
    .where(
      and(
        eq(terminalReaders.provider, provider),
        eq(terminalReaders.providerObjectId, providerObjectId),
      ),
    );
  return row ? toReaderRow(row as RawReader) : null;
}

export async function listTerminalReadersForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly locationId?: string | undefined;
    readonly status?: TerminalReaderStatus | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: TerminalReaderRow[]; hasMore: boolean }> {
  const walk = keyset(terminalReaders.id, terminalReaders.createdAt, params.page);
  const rows = await db
    .select(READER_COLUMNS)
    .from(terminalReaders)
    .where(
      and(
        eq(terminalReaders.merchantId, params.merchantId),
        params.locationId === undefined
          ? undefined
          : eq(terminalReaders.locationId, params.locationId),
        params.status === undefined ? undefined : eq(terminalReaders.status, params.status),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map((row) => toReaderRow(row as RawReader)));
}

/** The merchant's readers among these `tmr_…` (an expansion's loader). */
export async function findTerminalReadersForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<TerminalReaderRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(READER_COLUMNS)
    .from(terminalReaders)
    .where(
      and(
        eq(terminalReaders.merchantId, merchantId),
        inArray(terminalReaders.publicId, [...publicIds]),
      ),
    );
  return rows.map((row) => toReaderRow(row as RawReader));
}

/** The label the provider accepted and the merchant's metadata patch. */
export async function updateTerminalReader(
  db: DatabaseOrTransaction,
  id: string,
  patch: { readonly label?: string | undefined; readonly metadata?: MetadataPatch | undefined },
): Promise<TerminalReaderRow | 'limit_exceeded' | null> {
  const merged =
    patch.metadata === undefined
      ? undefined
      : mergedMetadata(terminalReaders.metadata, patch.metadata);
  const [row] = await db
    .update(terminalReaders)
    .set({
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(merged !== undefined ? { metadata: merged } : {}),
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(
      and(
        eq(terminalReaders.id, id),
        merged === undefined ? undefined : metadataWithinLimit(merged),
      ),
    )
    .returning(READER_COLUMNS);
  if (row) return toReaderRow(row as RawReader);
  return (await findTerminalReaderById(db, id)) ? 'limit_exceeded' : null;
}

/** What the provider says about the device: never an action (only the CAS writers move one). */
export async function refreshTerminalReaderDevice(
  db: DatabaseOrTransaction,
  id: string,
  device: {
    readonly status: TerminalReaderStatus | null;
    readonly lastSeenAt: Date | null;
    readonly label: string;
    readonly deviceType: string;
  },
): Promise<TerminalReaderRow | null> {
  const [row] = await db
    .update(terminalReaders)
    .set({
      status: device.status,
      lastSeenAt: device.lastSeenAt,
      label: device.label,
      deviceType: device.deviceType,
    })
    .where(
      and(
        eq(terminalReaders.id, id),
        // Nothing to write is nothing written: a retrieve that changes nothing
        // does not touch the row.
        or(
          sql`${terminalReaders.status} is distinct from ${device.status}`,
          sql`${terminalReaders.lastSeenAt} is distinct from ${device.lastSeenAt?.toISOString() ?? null}::timestamptz`,
          ne(terminalReaders.label, device.label),
          ne(terminalReaders.deviceType, device.deviceType),
        ),
      ),
    )
    .returning(READER_COLUMNS);
  return row ? toReaderRow(row as RawReader) : null;
}

/**
 * Claim the reader for a collection of `paymentIntentId` — Orbit is about to
 * ask the provider. A compare-and-swap: refused (`null`) while the reader's
 * action is still `in_progress`, whichever payment it is for.
 */
export async function claimReaderAction(
  db: DatabaseOrTransaction,
  id: string,
  action: { readonly paymentIntentId: string; readonly enableCustomerCancellation: boolean },
): Promise<TerminalReaderRow | 'intent_busy' | null> {
  try {
    return await claim(db, id, action);
  } catch (error) {
    // Another reader is already collecting this payment
    // (`terminal_readers_collecting_intent_key`).
    if (isUniqueViolation(error, 'terminal_readers_collecting_intent_key')) return 'intent_busy';
    throw error;
  }
}

async function claim(
  db: DatabaseOrTransaction,
  id: string,
  action: { readonly paymentIntentId: string; readonly enableCustomerCancellation: boolean },
): Promise<TerminalReaderRow | null> {
  const [row] = await db
    .update(terminalReaders)
    .set({
      actionType: 'process_payment_intent',
      actionStatus: 'in_progress',
      actionPaymentIntentId: action.paymentIntentId,
      actionEnableCustomerCancellation: action.enableCustomerCancellation,
      actionFailureCode: null,
      actionStartedAt: sql`date_trunc('milliseconds', now())`,
      actionAcknowledgedAt: null,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(
      and(
        eq(terminalReaders.id, id),
        or(isNull(terminalReaders.actionStatus), ne(terminalReaders.actionStatus, 'in_progress')),
      ),
    )
    .returning(READER_COLUMNS);
  return row ? toReaderRow(row as RawReader) : null;
}

/** The provider took the claimed action: from now on its reader read is about THIS attempt. */
export async function acknowledgeReaderAction(
  db: DatabaseOrTransaction,
  id: string,
  startedAt: Date,
): Promise<TerminalReaderRow | null> {
  const [row] = await db
    .update(terminalReaders)
    .set({ actionAcknowledgedAt: sql`date_trunc('milliseconds', now())` })
    .where(
      and(
        eq(terminalReaders.id, id),
        eq(terminalReaders.actionStartedAt, startedAt),
        isNull(terminalReaders.actionAcknowledgedAt),
      ),
    )
    .returning(READER_COLUMNS);
  return row ? toReaderRow(row as RawReader) : null;
}

/**
 * Give the claim back: the provider refused the action, so the reader is as
 * it was before. Guarded on the claim being this one and still unanswered.
 */
export async function releaseReaderAction(
  db: DatabaseOrTransaction,
  id: string,
  startedAt: Date,
  previous: TerminalReaderActionRow | null,
): Promise<void> {
  // A claim only succeeds over an action that was NOT in progress; restoring
  // one that was would resurrect an attempt to be settled again.
  if (previous?.status === 'in_progress') previous = null;
  await db
    .update(terminalReaders)
    .set({
      actionType: previous?.type ?? null,
      actionStatus: previous?.status ?? null,
      actionPaymentIntentId: previous?.paymentIntentId ?? null,
      actionEnableCustomerCancellation: previous?.enableCustomerCancellation ?? null,
      actionFailureCode: previous?.failureCode ?? null,
      actionStartedAt: previous?.startedAt ?? null,
      actionAcknowledgedAt: previous?.acknowledgedAt ?? null,
    })
    .where(
      and(
        eq(terminalReaders.id, id),
        eq(terminalReaders.actionStartedAt, startedAt),
        eq(terminalReaders.actionStatus, 'in_progress'),
      ),
    );
}

/**
 * Write the outcome of the attempt started at `startedAt` — once. `null` when
 * the action is no longer that attempt in progress (another reader of the
 * provider settled it first, or a newer attempt was claimed).
 */
export async function settleReaderAction(
  db: DatabaseOrTransaction,
  id: string,
  startedAt: Date,
  outcome:
    | { readonly status: 'succeeded' }
    | { readonly status: 'failed'; readonly failureCode: string | null },
): Promise<TerminalReaderRow | null> {
  const [row] = await db
    .update(terminalReaders)
    .set({
      actionStatus: outcome.status,
      actionFailureCode: outcome.status === 'failed' ? outcome.failureCode : null,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(
      and(
        eq(terminalReaders.id, id),
        eq(terminalReaders.actionStartedAt, startedAt),
        eq(terminalReaders.actionStatus, 'in_progress'),
      ),
    )
    .returning(READER_COLUMNS);
  return row ? toReaderRow(row as RawReader) : null;
}

/** Delete the reader, unless it is collecting a payment. */
export async function deleteTerminalReader(
  db: DatabaseOrTransaction,
  id: string,
): Promise<'deleted' | 'busy' | 'missing'> {
  const rows = await db
    .delete(terminalReaders)
    .where(
      and(
        eq(terminalReaders.id, id),
        or(isNull(terminalReaders.actionStatus), ne(terminalReaders.actionStatus, 'in_progress')),
      ),
    )
    .returning({ id: terminalReaders.id });
  if (rows.length === 1) return 'deleted';
  return (await findTerminalReaderById(db, id)) ? 'busy' : 'missing';
}
