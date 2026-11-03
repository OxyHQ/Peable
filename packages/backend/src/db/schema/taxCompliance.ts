import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  TAX_CUSTOMER_TYPES,
  TAX_DOCUMENT_KINDS,
  TAX_FILING_FREQUENCIES,
  TAX_LEGAL_ENTITY_TYPES,
  TAX_OPERATING_LOCATION_KINDS,
  TAX_REGISTRATION_DECLARATION_STATUSES,
  TAX_REGISTRATION_SCHEMES,
  TAX_REVIEW_DECISIONS,
  TAX_REVIEW_ITEM_STATUSES,
  type TaxAssessmentResult,
  type TaxObligationOutcome,
  type TaxSupplyType,
} from '@peable.to/shared-types';
import { files } from './files';
import { merchants } from './merchants';
import { taxRegistrations } from './tax';

/**
 * Peable Tax business compliance (ADR 0020). Every table is scoped to ONE
 * merchant — an application in one environment, the same tenant as
 * `tax_settings` — and nothing here is read by the calculator: collection is
 * still decided only by `tax_registrations` the owner approved.
 */

export const TAX_ACTOR_TYPES = ['user', 'service', 'system'] as const;
export const TAX_REVIEW_SEVERITIES = ['action_required', 'review'] as const;

const countryCheck = (name: string, column: string) =>
  check(name, sql.raw(`${column} ~ '^[A-Z]{2}$'`));
const stateCheck = (name: string, column: string) =>
  check(name, sql.raw(`${column} is null or ${column} ~ '^[A-Z0-9]{1,3}$'`));

/** The business behind a merchant. No row means every answer is `unknown`. */
export const taxBusinessProfiles = pgTable(
  'tax_business_profiles',
  {
    merchantId: text()
      .primaryKey()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    entityType: text({ enum: TAX_LEGAL_ENTITY_TYPES }).notNull().default('unknown'),
    incorporationCountry: text(),
    incorporationState: text(),
    fiscalYearEndMonth: integer(),
    customerTypes: text({ enum: TAX_CUSTOMER_TYPES }).notNull().default('unknown'),
    supplyTypes: jsonb().$type<TaxSupplyType[]>().notNull().default([]),
    metadata: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** An Oxy user id; Oxy owns identity, so no foreign key. */
    updatedBy: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check(
      'tax_business_profiles_entity_type_check',
      sql.raw(`entity_type in (${inList(TAX_LEGAL_ENTITY_TYPES)})`),
    ),
    check(
      'tax_business_profiles_customer_types_check',
      sql.raw(`customer_types in (${inList(TAX_CUSTOMER_TYPES)})`),
    ),
    check(
      'tax_business_profiles_country_check',
      sql.raw(`incorporation_country is null or incorporation_country ~ '^[A-Z]{2}$'`),
    ),
    stateCheck('tax_business_profiles_state_check', 'incorporation_state'),
    check(
      'tax_business_profiles_fiscal_month_check',
      sql.raw('fiscal_year_end_month is null or fiscal_year_end_month between 1 and 12'),
    ),
  ],
);

/** Where the business actually operates. Ended, never deleted. */
export const taxOperatingLocations = pgTable(
  'tax_operating_locations',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    kind: text({ enum: TAX_OPERATING_LOCATION_KINDS }).notNull(),
    country: text().notNull(),
    state: text(),
    description: text(),
    startedAt: timestamptz(),
    endedAt: timestamptz(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'tax_operating_locations_kind_check',
      sql.raw(`kind in (${inList(TAX_OPERATING_LOCATION_KINDS)})`),
    ),
    countryCheck('tax_operating_locations_country_check', 'country'),
    stateCheck('tax_operating_locations_state_check', 'state'),
    check(
      'tax_operating_locations_period_check',
      sql`${t.endedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.endedAt} > ${t.startedAt}`,
    ),
    index('tax_operating_locations_merchant_idx').on(t.merchantId, t.id),
  ],
);

/** Where the business says it sells. */
export const taxSalesDestinations = pgTable(
  'tax_sales_destinations',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    country: text().notNull(),
    state: text(),
    customerTypes: text({ enum: TAX_CUSTOMER_TYPES }).notNull().default('unknown'),
    startedAt: timestamptz(),
    endedAt: timestamptz(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    countryCheck('tax_sales_destinations_country_check', 'country'),
    stateCheck('tax_sales_destinations_state_check', 'state'),
    check(
      'tax_sales_destinations_customer_types_check',
      sql.raw(`customer_types in (${inList(TAX_CUSTOMER_TYPES)})`),
    ),
    check(
      'tax_sales_destinations_period_check',
      sql`${t.endedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.endedAt} > ${t.startedAt}`,
    ),
    index('tax_sales_destinations_merchant_idx').on(t.merchantId, t.id),
  ],
);

/**
 * Where the business SAYS it stands with an authority. Never read by the
 * calculator, never verified: `collection_registration_id` only points at the
 * approved Peable Tax registration it corresponds to, when the owner made one.
 */
export const taxRegistrationDeclarations = pgTable(
  'tax_registration_declarations',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    country: text().notNull(),
    state: text(),
    scheme: text({ enum: TAX_REGISTRATION_SCHEMES }),
    status: text({ enum: TAX_REGISTRATION_DECLARATION_STATUSES }).notNull(),
    effectiveFrom: timestamptz(),
    effectiveTo: timestamptz(),
    filingFrequency: text({ enum: TAX_FILING_FREQUENCIES }).notNull().default('unknown'),
    collectionRegistrationId: text(),
    note: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    countryCheck('tax_registration_declarations_country_check', 'country'),
    stateCheck('tax_registration_declarations_state_check', 'state'),
    check(
      'tax_registration_declarations_scheme_check',
      sql.raw(`scheme is null or scheme in (${inList(TAX_REGISTRATION_SCHEMES)})`),
    ),
    check(
      'tax_registration_declarations_status_check',
      sql.raw(`status in (${inList(TAX_REGISTRATION_DECLARATION_STATUSES)})`),
    ),
    check(
      'tax_registration_declarations_frequency_check',
      sql.raw(`filing_frequency in (${inList(TAX_FILING_FREQUENCIES)})`),
    ),
    // A registration has a start; an ended one has an end; an end follows the start.
    check(
      'tax_registration_declarations_registered_dated_check',
      sql`${t.status} NOT IN ('registered', 'ended') OR ${t.effectiveFrom} IS NOT NULL`,
    ),
    check(
      'tax_registration_declarations_ended_dated_check',
      sql`${t.status} <> 'ended' OR ${t.effectiveTo} IS NOT NULL`,
    ),
    check(
      'tax_registration_declarations_period_check',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveFrom} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    // Named by hand: drizzle's generated name passes Postgres' 63-byte limit.
    foreignKey({
      name: 'tax_registration_declarations_collection_fkey',
      columns: [t.collectionRegistrationId],
      foreignColumns: [taxRegistrations.id],
    }).onDelete('restrict'),
    index('tax_registration_declarations_merchant_idx').on(t.merchantId, t.id),
  ],
);

/**
 * A supporting document: the merchant's OWN `tax_document` file, structurally
 * — the composite reference names `files (id, merchant_id, purpose)` with the
 * purpose pinned, so another merchant's file, or this merchant's dispute
 * evidence, cannot be attached by naming its id.
 */
export const taxComplianceDocuments = pgTable(
  'tax_compliance_documents',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    fileId: text().notNull(),
    filePurpose: text().notNull().default('tax_document'),
    kind: text({ enum: TAX_DOCUMENT_KINDS }).notNull(),
    country: text(),
    state: text(),
    declarationId: text(),
    description: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'tax_compliance_documents_file_fkey',
      columns: [t.fileId, t.merchantId, t.filePurpose],
      foreignColumns: [files.id, files.merchantId, files.purpose],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_compliance_documents_declaration_fkey',
      columns: [t.declarationId],
      foreignColumns: [taxRegistrationDeclarations.id],
    }).onDelete('restrict'),
    unique('tax_compliance_documents_file_key').on(t.fileId),
    check('tax_compliance_documents_purpose_check', sql`${t.filePurpose} = 'tax_document'`),
    check(
      'tax_compliance_documents_kind_check',
      sql.raw(`kind in (${inList(TAX_DOCUMENT_KINDS)})`),
    ),
    check(
      'tax_compliance_documents_country_check',
      sql.raw(`country is null or country ~ '^[A-Z]{2}$'`),
    ),
    stateCheck('tax_compliance_documents_state_check', 'state'),
    index('tax_compliance_documents_merchant_idx').on(t.merchantId, t.id),
  ],
);

/**
 * A frozen assessment: the rule set version, the exact inputs it judged (so
 * it can be replayed) and what it found. Immutable — a new judgement is a new
 * row.
 */
export const taxComplianceAssessments = pgTable(
  'tax_compliance_assessments',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    ruleSetVersion: text().notNull(),
    asOf: timestamptz().notNull(),
    inputs: jsonb().$type<Record<string, unknown>>().notNull(),
    inputsDigest: text().notNull(),
    results: jsonb().$type<TaxAssessmentResult[]>().notNull(),
    summary: jsonb().$type<Record<TaxObligationOutcome, number>>().notNull(),
    actorType: text({ enum: TAX_ACTOR_TYPES }).notNull(),
    /** An Oxy user or application id — Oxy's key space, no foreign key. */
    actorId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'tax_compliance_assessments_actor_check',
      sql.raw(`actor_type in (${inList(TAX_ACTOR_TYPES)})`),
    ),
    check('tax_compliance_assessments_digest_check', sql`${t.inputsDigest} ~ '^[0-9a-f]{64}$'`),
    index('tax_compliance_assessments_merchant_idx').on(t.merchantId, t.id),
  ],
);

/**
 * The review queue. An assessment that finds the same thing again keeps the
 * OPEN item rather than opening a second: `(merchant_id, dedupe_key)` is
 * unique among open items only, so a resolved finding can be raised afresh.
 */
export const taxReviewItems = pgTable(
  'tax_review_items',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    dedupeKey: text().notNull(),
    code: text().notNull(),
    severity: text({ enum: TAX_REVIEW_SEVERITIES }).notNull(),
    status: text({ enum: TAX_REVIEW_ITEM_STATUSES }).notNull().default('open'),
    rule: text(),
    country: text(),
    state: text(),
    message: text().notNull(),
    firstAssessmentId: text(),
    latestAssessmentId: text(),
    decision: text({ enum: TAX_REVIEW_DECISIONS }),
    decisionNote: text(),
    decidedBy: text(),
    decidedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'tax_review_items_first_assessment_fkey',
      columns: [t.firstAssessmentId],
      foreignColumns: [taxComplianceAssessments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tax_review_items_latest_assessment_fkey',
      columns: [t.latestAssessmentId],
      foreignColumns: [taxComplianceAssessments.id],
    }).onDelete('restrict'),
    uniqueIndex('tax_review_items_open_key')
      .on(t.merchantId, t.dedupeKey)
      .where(sql`${t.status} = 'open'`),
    check(
      'tax_review_items_status_check',
      sql.raw(`status in (${inList(TAX_REVIEW_ITEM_STATUSES)})`),
    ),
    check(
      'tax_review_items_severity_check',
      sql.raw(`severity in (${inList(TAX_REVIEW_SEVERITIES)})`),
    ),
    check(
      'tax_review_items_decision_check',
      sql.raw(`decision is null or decision in (${inList(TAX_REVIEW_DECISIONS)})`),
    ),
    // Open ⟺ undecided, and a decision always says who and when.
    check(
      'tax_review_items_decided_check',
      sql`(${t.status} = 'open') = (${t.decision} IS NULL) AND (${t.decision} IS NULL) = (${t.decidedBy} IS NULL) AND (${t.decision} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    index('tax_review_items_merchant_idx').on(t.merchantId, t.id),
  ],
);

/**
 * The action history: one row per change, written in the change's own
 * transaction. Append-only. `details` holds field names and statuses — never
 * a registration number or a document's content.
 */
export const taxComplianceActions = pgTable(
  'tax_compliance_actions',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    action: text().notNull(),
    actorType: text({ enum: TAX_ACTOR_TYPES }).notNull(),
    /** An Oxy user or application id — Oxy's key space, no foreign key. */
    actorId: text(),
    objectType: text().notNull(),
    /** The PUBLIC id of the object acted on, as the API names it. */
    objectId: text(),
    details: jsonb().$type<Record<string, string | number | boolean | null>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'tax_compliance_actions_actor_check',
      sql.raw(`actor_type in (${inList(TAX_ACTOR_TYPES)})`),
    ),
    index('tax_compliance_actions_merchant_idx').on(t.merchantId, t.id),
  ],
);
