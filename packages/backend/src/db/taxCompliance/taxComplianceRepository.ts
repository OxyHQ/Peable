/**
 * The one reader and writer of the business-compliance tables (ADR 0020).
 * Every function takes the merchant's INTERNAL id and scopes by it: there is
 * no lookup here that can reach another merchant's row by naming its id.
 */
import { and, asc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import { files, taxCalculations, taxRegistrations, taxSettings, taxTransactions } from '../schema';
import {
  taxBusinessProfiles,
  taxComplianceActions,
  taxComplianceAssessments,
  taxComplianceDocuments,
  taxOperatingLocations,
  taxRegistrationDeclarations,
  taxReviewItems,
  taxSalesDestinations,
} from '../schema/taxCompliance';

export type BusinessProfileRow = typeof taxBusinessProfiles.$inferSelect;
export type OperatingLocationRow = typeof taxOperatingLocations.$inferSelect;
export type SalesDestinationRow = typeof taxSalesDestinations.$inferSelect;
export type DeclarationRow = typeof taxRegistrationDeclarations.$inferSelect & {
  collectionRegistrationPublicId: string | null;
};
export type AssessmentRow = typeof taxComplianceAssessments.$inferSelect;
export type ReviewItemRow = typeof taxReviewItems.$inferSelect & {
  firstAssessmentPublicId: string | null;
  latestAssessmentPublicId: string | null;
};
export type ActionRow = typeof taxComplianceActions.$inferSelect;
export interface DocumentRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly kind: (typeof taxComplianceDocuments.$inferSelect)['kind'];
  readonly country: string | null;
  readonly state: string | null;
  readonly description: string | null;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
  readonly filePublicId: string;
  readonly filename: string | null;
  readonly fileWithheld: string | null;
  readonly fileRemovedAt: Date | null;
  readonly declarationPublicId: string | null;
}

type Paged<T> = { data: T[]; hasMore: boolean };

// ── Business profile ─────────────────────────────────────────────────────────

export async function findBusinessProfile(db: DatabaseOrTransaction, merchantId: string) {
  const [row] = await db
    .select()
    .from(taxBusinessProfiles)
    .where(eq(taxBusinessProfiles.merchantId, merchantId));
  return row ?? null;
}

export async function upsertBusinessProfile(
  db: DatabaseOrTransaction,
  merchantId: string,
  values: Partial<
    Pick<
      BusinessProfileRow,
      | 'entityType'
      | 'incorporationCountry'
      | 'incorporationState'
      | 'fiscalYearEndMonth'
      | 'customerTypes'
      | 'supplyTypes'
      | 'updatedBy'
    >
  >,
  metadata: MetadataPatch | undefined,
): Promise<BusinessProfileRow | null> {
  await db.insert(taxBusinessProfiles).values({ merchantId }).onConflictDoNothing();
  const merged = metadata ? mergedMetadata(taxBusinessProfiles.metadata, metadata) : undefined;
  const [row] = await db
    .update(taxBusinessProfiles)
    .set({ ...values, ...(merged ? { metadata: merged } : {}), updatedAt: new Date() })
    .where(
      and(
        eq(taxBusinessProfiles.merchantId, merchantId),
        merged ? metadataWithinLimit(merged) : undefined,
      ),
    )
    .returning();
  return row ?? null;
}

// ── Operating locations and sales destinations ───────────────────────────────

export async function insertOperatingLocation(
  db: DatabaseOrTransaction,
  values: typeof taxOperatingLocations.$inferInsert,
): Promise<OperatingLocationRow> {
  const [row] = await db.insert(taxOperatingLocations).values(values).returning();
  if (!row) throw new Error('operating location insert returned nothing');
  return row;
}

export async function findOperatingLocation(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
) {
  const [row] = await db
    .select()
    .from(taxOperatingLocations)
    .where(
      and(
        eq(taxOperatingLocations.merchantId, merchantId),
        eq(taxOperatingLocations.publicId, publicId),
      ),
    );
  return row ?? null;
}

export async function updateOperatingLocation(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
  values: Partial<Pick<OperatingLocationRow, 'description' | 'startedAt' | 'endedAt'>>,
  metadata: MetadataPatch | undefined,
): Promise<OperatingLocationRow | null> {
  const merged = metadata ? mergedMetadata(taxOperatingLocations.metadata, metadata) : undefined;
  const [row] = await db
    .update(taxOperatingLocations)
    .set({ ...values, ...(merged ? { metadata: merged } : {}), updatedAt: new Date() })
    .where(
      and(
        eq(taxOperatingLocations.merchantId, merchantId),
        eq(taxOperatingLocations.publicId, publicId),
        merged ? metadataWithinLimit(merged) : undefined,
      ),
    )
    .returning();
  return row ?? null;
}

export async function listOperatingLocations(
  db: DatabaseOrTransaction,
  merchantId: string,
  page: KeysetPage,
): Promise<Paged<OperatingLocationRow>> {
  const walk = keyset(taxOperatingLocations.id, taxOperatingLocations.createdAt, page);
  const rows = await db
    .select()
    .from(taxOperatingLocations)
    .where(and(eq(taxOperatingLocations.merchantId, merchantId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

export async function allOperatingLocations(db: DatabaseOrTransaction, merchantId: string) {
  return db
    .select()
    .from(taxOperatingLocations)
    .where(eq(taxOperatingLocations.merchantId, merchantId))
    .orderBy(asc(taxOperatingLocations.id));
}

export async function insertSalesDestination(
  db: DatabaseOrTransaction,
  values: typeof taxSalesDestinations.$inferInsert,
): Promise<SalesDestinationRow> {
  const [row] = await db.insert(taxSalesDestinations).values(values).returning();
  if (!row) throw new Error('sales destination insert returned nothing');
  return row;
}

export async function findSalesDestination(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
) {
  const [row] = await db
    .select()
    .from(taxSalesDestinations)
    .where(
      and(
        eq(taxSalesDestinations.merchantId, merchantId),
        eq(taxSalesDestinations.publicId, publicId),
      ),
    );
  return row ?? null;
}

export async function updateSalesDestination(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
  values: Partial<Pick<SalesDestinationRow, 'customerTypes' | 'startedAt' | 'endedAt'>>,
  metadata: MetadataPatch | undefined,
): Promise<SalesDestinationRow | null> {
  const merged = metadata ? mergedMetadata(taxSalesDestinations.metadata, metadata) : undefined;
  const [row] = await db
    .update(taxSalesDestinations)
    .set({ ...values, ...(merged ? { metadata: merged } : {}), updatedAt: new Date() })
    .where(
      and(
        eq(taxSalesDestinations.merchantId, merchantId),
        eq(taxSalesDestinations.publicId, publicId),
        merged ? metadataWithinLimit(merged) : undefined,
      ),
    )
    .returning();
  return row ?? null;
}

export async function listSalesDestinations(
  db: DatabaseOrTransaction,
  merchantId: string,
  page: KeysetPage,
): Promise<Paged<SalesDestinationRow>> {
  const walk = keyset(taxSalesDestinations.id, taxSalesDestinations.createdAt, page);
  const rows = await db
    .select()
    .from(taxSalesDestinations)
    .where(and(eq(taxSalesDestinations.merchantId, merchantId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

export async function allSalesDestinations(db: DatabaseOrTransaction, merchantId: string) {
  return db
    .select()
    .from(taxSalesDestinations)
    .where(eq(taxSalesDestinations.merchantId, merchantId))
    .orderBy(asc(taxSalesDestinations.id));
}

// ── Registration declarations ────────────────────────────────────────────────

const DECLARATION_COLUMNS = {
  id: taxRegistrationDeclarations.id,
  publicId: taxRegistrationDeclarations.publicId,
  merchantId: taxRegistrationDeclarations.merchantId,
  country: taxRegistrationDeclarations.country,
  state: taxRegistrationDeclarations.state,
  scheme: taxRegistrationDeclarations.scheme,
  status: taxRegistrationDeclarations.status,
  effectiveFrom: taxRegistrationDeclarations.effectiveFrom,
  effectiveTo: taxRegistrationDeclarations.effectiveTo,
  filingFrequency: taxRegistrationDeclarations.filingFrequency,
  collectionRegistrationId: taxRegistrationDeclarations.collectionRegistrationId,
  note: taxRegistrationDeclarations.note,
  metadata: taxRegistrationDeclarations.metadata,
  createdAt: taxRegistrationDeclarations.createdAt,
  updatedAt: taxRegistrationDeclarations.updatedAt,
  collectionRegistrationPublicId: sql<
    string | null
  >`(select ${taxRegistrations.publicId} from ${taxRegistrations} where ${taxRegistrations.id} = ${taxRegistrationDeclarations.collectionRegistrationId})`,
};

export async function insertDeclaration(
  db: DatabaseOrTransaction,
  values: typeof taxRegistrationDeclarations.$inferInsert,
): Promise<DeclarationRow> {
  const [row] = await db
    .insert(taxRegistrationDeclarations)
    .values(values)
    .returning(DECLARATION_COLUMNS);
  if (!row) throw new Error('declaration insert returned nothing');
  return row;
}

export async function findDeclaration(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<DeclarationRow | null> {
  const query = db
    .select(DECLARATION_COLUMNS)
    .from(taxRegistrationDeclarations)
    .where(
      and(
        eq(taxRegistrationDeclarations.merchantId, merchantId),
        eq(taxRegistrationDeclarations.publicId, publicId),
      ),
    );
  const [row] = opts.forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

export async function updateDeclaration(
  db: DatabaseOrTransaction,
  merchantId: string,
  id: string,
  values: Partial<typeof taxRegistrationDeclarations.$inferInsert>,
  metadata: MetadataPatch | undefined,
): Promise<DeclarationRow | null> {
  const merged = metadata
    ? mergedMetadata(taxRegistrationDeclarations.metadata, metadata)
    : undefined;
  const [row] = await db
    .update(taxRegistrationDeclarations)
    .set({ ...values, ...(merged ? { metadata: merged } : {}), updatedAt: new Date() })
    .where(
      and(
        eq(taxRegistrationDeclarations.merchantId, merchantId),
        eq(taxRegistrationDeclarations.id, id),
        merged ? metadataWithinLimit(merged) : undefined,
      ),
    )
    .returning(DECLARATION_COLUMNS);
  return row ?? null;
}

export async function listDeclarations(
  db: DatabaseOrTransaction,
  merchantId: string,
  page: KeysetPage,
): Promise<Paged<DeclarationRow>> {
  const walk = keyset(taxRegistrationDeclarations.id, taxRegistrationDeclarations.createdAt, page);
  const rows = await db
    .select(DECLARATION_COLUMNS)
    .from(taxRegistrationDeclarations)
    .where(and(eq(taxRegistrationDeclarations.merchantId, merchantId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

export async function allDeclarations(db: DatabaseOrTransaction, merchantId: string) {
  return db
    .select(DECLARATION_COLUMNS)
    .from(taxRegistrationDeclarations)
    .where(eq(taxRegistrationDeclarations.merchantId, merchantId))
    .orderBy(asc(taxRegistrationDeclarations.id));
}

/** A Peable Tax registration of THIS merchant, by public id. */
export async function findCollectionRegistration(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
) {
  const [row] = await db
    .select()
    .from(taxRegistrations)
    .where(
      and(eq(taxRegistrations.merchantId, merchantId), eq(taxRegistrations.publicId, publicId)),
    );
  return row ?? null;
}

/** The owner's APPROVED collection registrations — read, never written, here. */
export async function approvedCollectionRegistrations(
  db: DatabaseOrTransaction,
  merchantId: string,
) {
  return db
    .select()
    .from(taxRegistrations)
    .where(and(eq(taxRegistrations.merchantId, merchantId), isNotNull(taxRegistrations.approvedAt)))
    .orderBy(asc(taxRegistrations.createdAt));
}

// ── Documents ────────────────────────────────────────────────────────────────

const DOCUMENT_COLUMNS = {
  id: taxComplianceDocuments.id,
  publicId: taxComplianceDocuments.publicId,
  merchantId: taxComplianceDocuments.merchantId,
  kind: taxComplianceDocuments.kind,
  country: taxComplianceDocuments.country,
  state: taxComplianceDocuments.state,
  description: taxComplianceDocuments.description,
  metadata: taxComplianceDocuments.metadata,
  createdAt: taxComplianceDocuments.createdAt,
  filePublicId: files.publicId,
  filename: files.filename,
  fileWithheld: files.withheld,
  fileRemovedAt: files.removedAt,
  declarationPublicId: sql<
    string | null
  >`(select ${taxRegistrationDeclarations.publicId} from ${taxRegistrationDeclarations} where ${taxRegistrationDeclarations.id} = ${taxComplianceDocuments.declarationId})`,
};

export async function insertDocument(
  db: DatabaseOrTransaction,
  values: typeof taxComplianceDocuments.$inferInsert,
): Promise<string | null> {
  const [row] = await db
    .insert(taxComplianceDocuments)
    .values(values)
    .onConflictDoNothing({ target: taxComplianceDocuments.fileId })
    .returning({ publicId: taxComplianceDocuments.publicId });
  return row?.publicId ?? null;
}

export async function findDocument(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<DocumentRow | null> {
  const [row] = await db
    .select(DOCUMENT_COLUMNS)
    .from(taxComplianceDocuments)
    .innerJoin(files, eq(files.id, taxComplianceDocuments.fileId))
    .where(
      and(
        eq(taxComplianceDocuments.merchantId, merchantId),
        eq(taxComplianceDocuments.publicId, publicId),
      ),
    );
  return row ?? null;
}

export async function findDocumentByFile(
  db: DatabaseOrTransaction,
  merchantId: string,
  fileId: string,
): Promise<DocumentRow | null> {
  const [row] = await db
    .select(DOCUMENT_COLUMNS)
    .from(taxComplianceDocuments)
    .innerJoin(files, eq(files.id, taxComplianceDocuments.fileId))
    .where(
      and(
        eq(taxComplianceDocuments.merchantId, merchantId),
        eq(taxComplianceDocuments.fileId, fileId),
      ),
    );
  return row ?? null;
}

export async function listDocuments(
  db: DatabaseOrTransaction,
  merchantId: string,
  page: KeysetPage,
): Promise<Paged<DocumentRow>> {
  const walk = keyset(taxComplianceDocuments.id, taxComplianceDocuments.createdAt, page);
  const rows = await db
    .select(DOCUMENT_COLUMNS)
    .from(taxComplianceDocuments)
    .innerJoin(files, eq(files.id, taxComplianceDocuments.fileId))
    .where(and(eq(taxComplianceDocuments.merchantId, merchantId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

export async function allDocuments(db: DatabaseOrTransaction, merchantId: string) {
  return db
    .select(DOCUMENT_COLUMNS)
    .from(taxComplianceDocuments)
    .innerJoin(files, eq(files.id, taxComplianceDocuments.fileId))
    .where(eq(taxComplianceDocuments.merchantId, merchantId))
    .orderBy(asc(taxComplianceDocuments.id));
}

// ── Sales, from Peable Tax transactions ──────────────────────────────────────

/**
 * Net sales per destination, currency and UTC month, in `[from, to)` of the
 * tax date. An original adds its calculation's `amount_net`; a reversal adds
 * its own signed `amount_net` — the same netting as the summary report, so the
 * two can be reconciled. Summed in `numeric` and returned as text: a total is
 * never squeezed through a JS number.
 */
export async function monthlySales(
  db: DatabaseOrTransaction,
  merchantId: string,
  from: Date,
  to: Date,
) {
  const month = sql<string>`to_char(date_trunc('month', ${taxTransactions.committedAt} at time zone 'UTC'), 'YYYY-MM')`;
  const net = sql<string>`sum(case when ${taxTransactions.reversalOfId} is null then (${taxCalculations.result}->>'amount_net')::numeric else (${taxTransactions.reversal}->>'amount_net')::numeric end)::text`;
  const originals = sql<number>`(count(*) filter (where ${taxTransactions.reversalOfId} is null))::int`;
  return db
    .select({
      country: taxCalculations.country,
      state: taxCalculations.state,
      currency: taxCalculations.currency,
      month,
      net,
      transactions: originals,
    })
    .from(taxTransactions)
    .innerJoin(taxCalculations, eq(taxCalculations.id, taxTransactions.calculationId))
    .where(
      and(
        eq(taxTransactions.merchantId, merchantId),
        gte(taxTransactions.committedAt, from),
        lt(taxTransactions.committedAt, to),
      ),
    )
    .groupBy(taxCalculations.country, taxCalculations.state, taxCalculations.currency, month)
    .orderBy(taxCalculations.country, taxCalculations.state, taxCalculations.currency, month);
}

// ── Assessments ──────────────────────────────────────────────────────────────

export async function insertAssessment(
  db: DatabaseOrTransaction,
  values: typeof taxComplianceAssessments.$inferInsert,
): Promise<AssessmentRow> {
  const [row] = await db.insert(taxComplianceAssessments).values(values).returning();
  if (!row) throw new Error('assessment insert returned nothing');
  return row;
}

export async function findAssessment(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
) {
  const [row] = await db
    .select()
    .from(taxComplianceAssessments)
    .where(
      and(
        eq(taxComplianceAssessments.merchantId, merchantId),
        eq(taxComplianceAssessments.publicId, publicId),
      ),
    );
  return row ?? null;
}

export async function latestAssessment(db: DatabaseOrTransaction, merchantId: string) {
  const [row] = await db
    .select()
    .from(taxComplianceAssessments)
    .where(eq(taxComplianceAssessments.merchantId, merchantId))
    .orderBy(sql`${taxComplianceAssessments.id} desc`)
    .limit(1);
  return row ?? null;
}

export async function listAssessments(
  db: DatabaseOrTransaction,
  merchantId: string,
  page: KeysetPage,
): Promise<Paged<AssessmentRow>> {
  const walk = keyset(taxComplianceAssessments.id, taxComplianceAssessments.createdAt, page);
  const rows = await db
    .select()
    .from(taxComplianceAssessments)
    .where(and(eq(taxComplianceAssessments.merchantId, merchantId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

/** The results of an assessment, written in its own creating transaction once its review items exist. */
export async function setAssessmentResults(
  db: DatabaseOrTransaction,
  id: string,
  results: AssessmentRow['results'],
): Promise<AssessmentRow> {
  const [row] = await db
    .update(taxComplianceAssessments)
    .set({ results })
    .where(eq(taxComplianceAssessments.id, id))
    .returning();
  if (!row) throw new Error('assessment vanished');
  return row;
}

/** The seller's legal name, which lives in the tax settings (ADR 0011). */
export async function findLegalName(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ legalName: taxSettings.legalName })
    .from(taxSettings)
    .where(eq(taxSettings.merchantId, merchantId));
  return row?.legalName ?? null;
}

// ── Review items ─────────────────────────────────────────────────────────────

const assessmentPublicId = (column: AnyPgColumn) =>
  sql<
    string | null
  >`(select ${taxComplianceAssessments.publicId} from ${taxComplianceAssessments} where ${taxComplianceAssessments.id} = ${column})`;

const REVIEW_COLUMNS = {
  id: taxReviewItems.id,
  publicId: taxReviewItems.publicId,
  merchantId: taxReviewItems.merchantId,
  dedupeKey: taxReviewItems.dedupeKey,
  code: taxReviewItems.code,
  severity: taxReviewItems.severity,
  status: taxReviewItems.status,
  rule: taxReviewItems.rule,
  country: taxReviewItems.country,
  state: taxReviewItems.state,
  message: taxReviewItems.message,
  firstAssessmentId: taxReviewItems.firstAssessmentId,
  latestAssessmentId: taxReviewItems.latestAssessmentId,
  decision: taxReviewItems.decision,
  decisionNote: taxReviewItems.decisionNote,
  decidedBy: taxReviewItems.decidedBy,
  decidedAt: taxReviewItems.decidedAt,
  createdAt: taxReviewItems.createdAt,
  updatedAt: taxReviewItems.updatedAt,
  firstAssessmentPublicId: assessmentPublicId(taxReviewItems.firstAssessmentId),
  latestAssessmentPublicId: assessmentPublicId(taxReviewItems.latestAssessmentId),
};

/**
 * Open the item, or — when one is already open for the same finding — keep
 * that one and point it at the newer assessment. One statement per finding,
 * so two assessments racing still leave ONE open item (the partial unique
 * index decides, not a read).
 */
export async function upsertOpenReviewItem(
  db: DatabaseOrTransaction,
  values: typeof taxReviewItems.$inferInsert,
): Promise<{ row: ReviewItemRow; created: boolean }> {
  const inserted = await db
    .insert(taxReviewItems)
    .values(values)
    .onConflictDoUpdate({
      target: [taxReviewItems.merchantId, taxReviewItems.dedupeKey],
      targetWhere: sql`${taxReviewItems.status} = 'open'`,
      set: {
        latestAssessmentId: values.latestAssessmentId,
        message: values.message,
        updatedAt: new Date(),
      },
    })
    .returning({ id: taxReviewItems.id, created: sql<boolean>`(xmax = 0)` });
  const [first] = inserted;
  if (!first) throw new Error('review item upsert returned nothing');
  const [row] = await db
    .select(REVIEW_COLUMNS)
    .from(taxReviewItems)
    .where(eq(taxReviewItems.id, first.id));
  if (!row) throw new Error('review item vanished');
  return { row, created: first.created };
}

export async function findReviewItem(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<ReviewItemRow | null> {
  const [row] = await db
    .select(REVIEW_COLUMNS)
    .from(taxReviewItems)
    .where(and(eq(taxReviewItems.merchantId, merchantId), eq(taxReviewItems.publicId, publicId)));
  return row ?? null;
}

/**
 * Decide an OPEN item. A compare-and-swap on `status = 'open'`: of two owners
 * deciding at once, exactly one wins and the other is told the item moved.
 */
export async function decideReviewItem(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
  values: Pick<
    typeof taxReviewItems.$inferInsert,
    'status' | 'decision' | 'decisionNote' | 'decidedBy' | 'decidedAt'
  >,
): Promise<ReviewItemRow | null> {
  const [updated] = await db
    .update(taxReviewItems)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(taxReviewItems.merchantId, merchantId),
        eq(taxReviewItems.publicId, publicId),
        eq(taxReviewItems.status, 'open'),
      ),
    )
    .returning({ id: taxReviewItems.id });
  if (!updated) return null;
  return findReviewItem(db, merchantId, publicId);
}

export async function listReviewItems(
  db: DatabaseOrTransaction,
  merchantId: string,
  page: KeysetPage,
  status?: ReviewItemRow['status'],
): Promise<Paged<ReviewItemRow>> {
  const walk = keyset(taxReviewItems.id, taxReviewItems.createdAt, page);
  const rows = await db
    .select(REVIEW_COLUMNS)
    .from(taxReviewItems)
    .where(
      and(
        eq(taxReviewItems.merchantId, merchantId),
        status ? eq(taxReviewItems.status, status) : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

export async function openReviewItemCount(db: DatabaseOrTransaction, merchantId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taxReviewItems)
    .where(and(eq(taxReviewItems.merchantId, merchantId), eq(taxReviewItems.status, 'open')));
  return row?.count ?? 0;
}

// ── Action history ───────────────────────────────────────────────────────────

export async function insertAction(
  db: DatabaseOrTransaction,
  values: typeof taxComplianceActions.$inferInsert,
): Promise<ActionRow> {
  const [row] = await db.insert(taxComplianceActions).values(values).returning();
  if (!row) throw new Error('action insert returned nothing');
  return row;
}

export async function listActions(
  db: DatabaseOrTransaction,
  merchantId: string,
  page: KeysetPage,
): Promise<Paged<ActionRow>> {
  const walk = keyset(taxComplianceActions.id, taxComplianceActions.createdAt, page);
  const rows = await db
    .select()
    .from(taxComplianceActions)
    .where(and(eq(taxComplianceActions.merchantId, merchantId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

/** Public id → internal id, inside the merchant, for a list cursor. */
export async function cursorId(
  db: DatabaseOrTransaction,
  table:
    | typeof taxOperatingLocations
    | typeof taxSalesDestinations
    | typeof taxRegistrationDeclarations
    | typeof taxComplianceDocuments
    | typeof taxComplianceAssessments
    | typeof taxReviewItems
    | typeof taxComplianceActions,
  merchantId: string,
  publicId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.merchantId, merchantId), eq(table.publicId, publicId)));
  return row?.id ?? null;
}
