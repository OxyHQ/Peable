import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type {
  VerificationCheckStatus,
  VerificationErrorCode,
  VerificationRedactionStatus,
  VerificationSessionStatus,
  VerificationSessionType,
} from '@peable.to/shared-types';
import { verificationReports, verificationSessions } from '../schema';
import type { VerificationOptions } from '../schema/identity';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import type { ProviderId } from '../../services/providers/provider';

/**
 * Reads and writes for `verification_sessions` and `verification_reports`
 * (ADR 0023). Every status write is a compare-and-swap on the status it was
 * decided from; nothing here holds a person's data (`schema/identity.ts`).
 */
export interface VerificationSessionRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly type: VerificationSessionType;
  readonly status: VerificationSessionStatus;
  readonly options: VerificationOptions;
  readonly returnUrl: string | null;
  readonly clientReferenceId: string | null;
  readonly metadata: Record<string, string>;
  readonly hasLastError: boolean;
  readonly lastErrorCode: VerificationErrorCode | null;
  readonly redactionStatus: VerificationRedactionStatus | null;
  /** The newest report's `vr_…`, read in the same statement. */
  readonly lastReportPublicId: string | null;
  readonly provider: ProviderId;
  readonly providerObjectId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SESSION_COLUMNS = {
  livemode: merchantLivemodeOf(verificationSessions.merchantId),
  id: verificationSessions.id,
  publicId: verificationSessions.publicId,
  merchantId: verificationSessions.merchantId,
  type: verificationSessions.type,
  status: verificationSessions.status,
  options: verificationSessions.options,
  returnUrl: verificationSessions.returnUrl,
  clientReferenceId: verificationSessions.clientReferenceId,
  metadata: verificationSessions.metadata,
  hasLastError: verificationSessions.hasLastError,
  lastErrorCode: verificationSessions.lastErrorCode,
  redactionStatus: verificationSessions.redactionStatus,
  // Qualified by hand: drizzle renders a column bare inside `sql`, and a bare
  // `"id"` in this subquery would name the REPORT's id.
  lastReportPublicId: sql<
    string | null
  >`(select vr.public_id from verification_reports vr where vr.verification_session_id = "verification_sessions"."id" order by vr.id desc limit 1)`,
  provider: verificationSessions.provider,
  providerObjectId: verificationSessions.providerObjectId,
  createdAt: verificationSessions.createdAt,
  updatedAt: verificationSessions.updatedAt,
} as const;

function toSessionRow(row: unknown): VerificationSessionRow {
  return row as VerificationSessionRow;
}

export async function insertVerificationSession(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly type: VerificationSessionType;
    readonly status: VerificationSessionStatus;
    readonly options: VerificationOptions;
    readonly returnUrl: string | null;
    readonly clientReferenceId: string | null;
    readonly metadata: Record<string, string>;
    readonly provider: ProviderId;
    readonly providerObjectId: string;
  },
): Promise<VerificationSessionRow> {
  const [row] = await db
    .insert(verificationSessions)
    .values({ id: uuidv7(), ...params })
    .returning(SESSION_COLUMNS);
  if (!row) throw new Error(`verification session ${params.publicId} was not inserted`);
  return toSessionRow(row);
}

/** `vs_…` scoped to the merchant in the predicate. */
export async function findVerificationSessionForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<VerificationSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.publicId, publicId),
        eq(verificationSessions.merchantId, merchantId),
      ),
    );
  return row ? toSessionRow(row) : null;
}

export async function findVerificationSessionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<VerificationSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(verificationSessions)
    .where(eq(verificationSessions.id, id));
  return row ? toSessionRow(row) : null;
}

/** The drain's lookup: which session is this provider object? */
export async function findVerificationSessionByProviderObject(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerObjectId: string,
): Promise<VerificationSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.provider, provider),
        eq(verificationSessions.providerObjectId, providerObjectId),
      ),
    );
  return row ? toSessionRow(row) : null;
}

export async function listVerificationSessionsForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly status?: VerificationSessionStatus | undefined;
    readonly clientReferenceId?: string | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: VerificationSessionRow[]; hasMore: boolean }> {
  const walk = keyset(verificationSessions.id, verificationSessions.createdAt, params.page);
  const rows = await db
    .select(SESSION_COLUMNS)
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.merchantId, params.merchantId),
        params.status === undefined ? undefined : eq(verificationSessions.status, params.status),
        params.clientReferenceId === undefined
          ? undefined
          : eq(verificationSessions.clientReferenceId, params.clientReferenceId),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toSessionRow));
}

/** The merchant's sessions among these `vs_…` (an expansion's loader). */
export async function findVerificationSessionsForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<VerificationSessionRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(SESSION_COLUMNS)
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.merchantId, merchantId),
        inArray(verificationSessions.publicId, [...publicIds]),
      ),
    );
  return rows.map(toSessionRow);
}

export interface VerificationSessionStateChange {
  /** The compare half: the status this change was decided from. */
  readonly from: VerificationSessionStatus;
  readonly status: VerificationSessionStatus;
  /** The last attempt's failure; `null` clears it. */
  readonly lastError: { readonly code: VerificationErrorCode | null } | null;
  readonly redactionStatus: VerificationRedactionStatus | null;
}

export type VerificationSessionStateResult =
  | { readonly kind: 'updated'; readonly row: VerificationSessionRow }
  | { readonly kind: 'stale'; readonly current: VerificationSessionStatus }
  | { readonly kind: 'missing' };

/**
 * Write what the provider says, compare-and-swap on `status = from`, in the
 * caller's transaction. A session under redaction keeps nothing the merchant
 * attached to the person (`verification_sessions_redacted_holds_no_reference_check`),
 * so the same statement erases it.
 */
export async function updateVerificationSessionState(
  db: DatabaseOrTransaction,
  id: string,
  change: VerificationSessionStateChange,
): Promise<VerificationSessionStateResult> {
  const [row] = await db
    .update(verificationSessions)
    .set({
      status: change.status,
      hasLastError: change.lastError !== null,
      lastErrorCode: change.lastError?.code ?? null,
      redactionStatus: change.redactionStatus,
      ...(change.redactionStatus !== null
        ? { metadata: sql`'{}'::jsonb`, clientReferenceId: null }
        : {}),
    })
    .where(and(eq(verificationSessions.id, id), eq(verificationSessions.status, change.from)))
    .returning(SESSION_COLUMNS);
  if (row) return { kind: 'updated', row: toSessionRow(row) };
  const [current] = await db
    .select({ status: verificationSessions.status })
    .from(verificationSessions)
    .where(eq(verificationSessions.id, id));
  if (!current) return { kind: 'missing' };
  return { kind: 'stale', current: current.status as VerificationSessionStatus };
}

/**
 * Change a session's configuration — only while `requires_input` and not
 * redacted, in the same statement. `limit_exceeded` when the merged metadata
 * would exceed the key limit; `stale` when the session is no longer editable.
 */
export async function updateVerificationSessionConfig(
  db: DatabaseOrTransaction,
  id: string,
  patch: {
    readonly type?: VerificationSessionType | undefined;
    readonly options?: VerificationOptions | undefined;
    readonly metadata?: MetadataPatch | undefined;
  },
): Promise<VerificationSessionRow | 'limit_exceeded' | 'stale'> {
  const merged =
    patch.metadata === undefined
      ? undefined
      : mergedMetadata(verificationSessions.metadata, patch.metadata);
  const editable = and(
    eq(verificationSessions.id, id),
    eq(verificationSessions.status, 'requires_input'),
    sql`${verificationSessions.redactionStatus} is null`,
  );
  const [row] = await db
    .update(verificationSessions)
    .set({
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.options !== undefined ? { options: patch.options } : {}),
      ...(merged !== undefined ? { metadata: merged } : {}),
    })
    .where(and(editable, merged === undefined ? undefined : metadataWithinLimit(merged)))
    .returning(SESSION_COLUMNS);
  if (row) return toSessionRow(row);
  const [exists] = await db
    .select({ id: verificationSessions.id })
    .from(verificationSessions)
    .where(editable);
  return exists ? 'limit_exceeded' : 'stale';
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface VerificationCheckRow {
  readonly status: VerificationCheckStatus;
  readonly errorCode: VerificationErrorCode | null;
}

export interface VerificationReportRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly verificationSessionId: string;
  readonly sessionPublicId: string;
  readonly type: VerificationSessionType;
  readonly options: VerificationOptions;
  readonly document: VerificationCheckRow | null;
  readonly idNumber: VerificationCheckRow | null;
  readonly selfie: VerificationCheckRow | null;
  readonly createdAt: Date;
}

const REPORT_COLUMNS = {
  livemode: merchantLivemodeOf(verificationReports.merchantId),
  id: verificationReports.id,
  publicId: verificationReports.publicId,
  merchantId: verificationReports.merchantId,
  verificationSessionId: verificationReports.verificationSessionId,
  sessionPublicId: sql<string>`(select vs.public_id from verification_sessions vs where vs.id = "verification_reports"."verification_session_id")`,
  type: verificationReports.type,
  options: verificationReports.options,
  documentStatus: verificationReports.documentStatus,
  documentErrorCode: verificationReports.documentErrorCode,
  idNumberStatus: verificationReports.idNumberStatus,
  idNumberErrorCode: verificationReports.idNumberErrorCode,
  selfieStatus: verificationReports.selfieStatus,
  selfieErrorCode: verificationReports.selfieErrorCode,
  createdAt: verificationReports.createdAt,
} as const;

interface RawReport {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly verificationSessionId: string;
  readonly sessionPublicId: string;
  readonly type: string;
  readonly options: VerificationOptions;
  readonly documentStatus: string | null;
  readonly documentErrorCode: string | null;
  readonly idNumberStatus: string | null;
  readonly idNumberErrorCode: string | null;
  readonly selfieStatus: string | null;
  readonly selfieErrorCode: string | null;
  readonly createdAt: Date;
}

function check(status: string | null, errorCode: string | null): VerificationCheckRow | null {
  if (status === null) return null;
  return {
    status: status as VerificationCheckStatus,
    errorCode: errorCode as VerificationErrorCode | null,
  };
}

function toReportRow(raw: RawReport): VerificationReportRow {
  return {
    livemode: raw.livemode,
    id: raw.id,
    publicId: raw.publicId,
    merchantId: raw.merchantId,
    verificationSessionId: raw.verificationSessionId,
    sessionPublicId: raw.sessionPublicId,
    type: raw.type as VerificationSessionType,
    options: raw.options,
    document: check(raw.documentStatus, raw.documentErrorCode),
    idNumber: check(raw.idNumberStatus, raw.idNumberErrorCode),
    selfie: check(raw.selfieStatus, raw.selfieErrorCode),
    createdAt: raw.createdAt,
  };
}

/**
 * Record a provider report's outcomes once: a report is immutable at the
 * provider, so a second sighting of the same provider id writes nothing.
 * Answers whether this call inserted it.
 */
export async function recordVerificationReport(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly verificationSessionId: string;
    readonly type: VerificationSessionType;
    readonly options: VerificationOptions;
    readonly document: VerificationCheckRow | null;
    readonly idNumber: VerificationCheckRow | null;
    readonly selfie: VerificationCheckRow | null;
    readonly provider: ProviderId;
    readonly providerObjectId: string;
  },
): Promise<boolean> {
  const rows = await db
    .insert(verificationReports)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      verificationSessionId: params.verificationSessionId,
      type: params.type,
      options: params.options,
      documentStatus: params.document?.status ?? null,
      documentErrorCode: params.document?.errorCode ?? null,
      idNumberStatus: params.idNumber?.status ?? null,
      idNumberErrorCode: params.idNumber?.errorCode ?? null,
      selfieStatus: params.selfie?.status ?? null,
      selfieErrorCode: params.selfie?.errorCode ?? null,
      provider: params.provider,
      providerObjectId: params.providerObjectId,
    })
    .onConflictDoNothing({
      target: [verificationReports.provider, verificationReports.providerObjectId],
    })
    .returning({ id: verificationReports.id });
  return rows.length === 1;
}

export async function findVerificationReportForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<VerificationReportRow | null> {
  const [row] = await db
    .select(REPORT_COLUMNS)
    .from(verificationReports)
    .where(
      and(
        eq(verificationReports.publicId, publicId),
        eq(verificationReports.merchantId, merchantId),
      ),
    );
  return row ? toReportRow(row as RawReport) : null;
}

export async function listVerificationReportsForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly verificationSessionId?: string | undefined;
    readonly type?: VerificationSessionType | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: VerificationReportRow[]; hasMore: boolean }> {
  const walk = keyset(verificationReports.id, verificationReports.createdAt, params.page);
  const rows = await db
    .select(REPORT_COLUMNS)
    .from(verificationReports)
    .where(
      and(
        eq(verificationReports.merchantId, params.merchantId),
        params.verificationSessionId === undefined
          ? undefined
          : eq(verificationReports.verificationSessionId, params.verificationSessionId),
        params.type === undefined ? undefined : eq(verificationReports.type, params.type),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map((row) => toReportRow(row as RawReport)));
}

/** The merchant's reports among these `vr_…` (an expansion's loader). */
export async function findVerificationReportsForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<VerificationReportRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(REPORT_COLUMNS)
    .from(verificationReports)
    .where(
      and(
        eq(verificationReports.merchantId, merchantId),
        inArray(verificationReports.publicId, [...publicIds]),
      ),
    )
    .orderBy(desc(verificationReports.id));
  return rows.map((row) => toReportRow(row as RawReport));
}
