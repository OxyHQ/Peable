import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  TAX_REGISTRATION_SCHEMES,
  type TaxAddress,
  type TaxCalculation,
} from '@peable.to/shared-types';
import { merchants } from './merchants';

export const TAX_SETTINGS_STATUSES = ['draft', 'active'] as const;
export const TAX_BEHAVIORS = ['inclusive', 'exclusive'] as const;
export const TAX_CALCULATION_ACCOUNTS = ['platform', 'none'] as const;
export const TAX_EVIDENCE_STATUSES = ['sufficient', 'insufficient', 'conflicting'] as const;
export const TAX_COLLECTIONS = ['collect', 'not_registered', 'nontaxable'] as const;

/** One evidence item as stored: the location it points at, never more of the
 * customer than the rule needs. An IP address is kept only as a salted hash. */
export interface StoredTaxEvidenceItem {
  type: string;
  country: string;
  state: string | null;
  postalCode?: string | null;
  city?: string | null;
  line1?: string | null;
  line2?: string | null;
  ipHash?: string;
}

/**
 * A merchant's tax settings (Stripe Tax's "tax settings"): the seller's head
 * office, its defaults, and the owner's approval. No row means draft defaults.
 *
 * `approved_by` is an Oxy user id, deliberately without a foreign key (Oxy owns
 * identity) and deliberately not named `*_id`.
 */
export const taxSettings = pgTable(
  'tax_settings',
  {
    merchantId: text()
      .primaryKey()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    status: text({ enum: TAX_SETTINGS_STATUSES }).notNull().default('draft'),
    legalName: text(),
    headOffice: jsonb().$type<TaxAddress>(),
    defaultTaxCode: text().notNull().default('txcd_10000000'),
    defaultTaxBehavior: text({ enum: TAX_BEHAVIORS }).notNull().default('exclusive'),
    calculationAccount: text({ enum: TAX_CALCULATION_ACCOUNTS }).notNull().default('none'),
    approvedAt: timestamptz(),
    approvedBy: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('tax_settings_status_check', sql.raw(`status in (${inList(TAX_SETTINGS_STATUSES)})`)),
    check(
      'tax_settings_behavior_check',
      sql.raw(`default_tax_behavior in (${inList(TAX_BEHAVIORS)})`),
    ),
    check(
      'tax_settings_account_check',
      sql.raw(`calculation_account in (${inList(TAX_CALCULATION_ACCOUNTS)})`),
    ),
    check(
      'tax_settings_active_is_approved_check',
      sql`${t.status} <> 'active' OR (${t.approvedAt} IS NOT NULL AND ${t.approvedBy} IS NOT NULL)`,
    ),
  ],
);

/** Where a merchant is registered to collect. Only an APPROVED registration
 * covers a sale; `expires_at` ends one without deleting its history. */
export const taxRegistrations = pgTable(
  'tax_registrations',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    country: text().notNull(),
    state: text(),
    scheme: text({ enum: TAX_REGISTRATION_SCHEMES }).notNull(),
    registrationNumber: text(),
    activeFrom: timestamptz(),
    expiresAt: timestamptz(),
    approvedAt: timestamptz(),
    approvedBy: text(),
    providerRef: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'tax_registrations_scheme_check',
      sql.raw(`scheme in (${inList(TAX_REGISTRATION_SCHEMES)})`),
    ),
    check('tax_registrations_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check(
      'tax_registrations_approved_is_dated_check',
      sql`${t.approvedAt} IS NULL OR ${t.activeFrom} IS NOT NULL`,
    ),
    index('tax_registrations_merchant_idx').on(t.merchantId),
  ],
);

/** A product's (billing plan's) tax code. Absent: the merchant default. */
export const taxProductCodes = pgTable(
  'tax_product_codes',
  {
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    productRef: text().notNull(),
    taxCode: text().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.productRef] })],
);

/** Customer location evidence as captured at checkout, with the rule that
 * judged it. Immutable: new evidence is a new row. */
export const taxLocationEvidence = pgTable(
  'tax_location_evidence',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    customerRef: text().notNull(),
    status: text({ enum: TAX_EVIDENCE_STATUSES }).notNull(),
    rule: text().notNull(),
    country: text(),
    state: text(),
    items: jsonb().$type<StoredTaxEvidenceItem[]>().notNull(),
    observedAt: timestamptz().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'tax_location_evidence_status_check',
      sql.raw(`status in (${inList(TAX_EVIDENCE_STATUSES)})`),
    ),
    check(
      'tax_location_evidence_sufficient_has_country_check',
      sql`${t.status} <> 'sufficient' OR ${t.country} IS NOT NULL`,
    ),
  ],
);

/** A frozen calculation. `result` is the exact `TaxCalculation` returned to
 * the caller; the scalar columns are what reports filter on. */
export const taxCalculations = pgTable(
  'tax_calculations',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    evidenceId: text()
      .notNull()
      .references(() => taxLocationEvidence.id, { onDelete: 'restrict' }),
    registrationId: text().references(() => taxRegistrations.id, { onDelete: 'restrict' }),
    collection: text({ enum: TAX_COLLECTIONS }).notNull(),
    currency: text().notNull(),
    country: text().notNull(),
    state: text(),
    provider: text(),
    providerRef: text(),
    result: jsonb().$type<TaxCalculation>().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'tax_calculations_collection_check',
      sql.raw(`collection in (${inList(TAX_COLLECTIONS)})`),
    ),
    check(
      'tax_calculations_collect_has_registration_check',
      sql`${t.collection} <> 'collect' OR (${t.registrationId} IS NOT NULL AND ${t.provider} IS NOT NULL)`,
    ),
  ],
);

/** A calculation that priced an accepted payment. One per calculation, and a
 * rail object is committed once. */
export const taxTransactions = pgTable(
  'tax_transactions',
  {
    id: generatedId(),
    publicId: text().notNull().unique(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    calculationId: text()
      .notNull()
      .unique()
      .references(() => taxCalculations.id, { onDelete: 'restrict' }),
    reference: text().notNull(),
    rail: text().notNull(),
    committedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('tax_transactions_reference_key').on(t.merchantId, t.reference),
    index('tax_transactions_merchant_committed_idx').on(t.merchantId, t.committedAt),
  ],
);
