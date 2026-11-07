import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxy.so/db';
import type { VerificationSession } from '@peable.to/shared-types';
import { merchants } from './merchants';
import {
  PROVIDER_IDS,
  VERIFICATION_CHECK_STATUSES,
  VERIFICATION_ERROR_CODES,
  VERIFICATION_REDACTION_STATUSES,
  VERIFICATION_SESSION_STATUSES,
  VERIFICATION_SESSION_TYPES,
} from './valueSets';

const emptyMetadata = sql`'{}'::jsonb`;

/** A session's check options, in the wire shape (`VerificationSession.options`). */
export type VerificationOptions = VerificationSession['options'];

/**
 * An identity verification session (`vs_…`, ADR 0023) over the provider's
 * hosted flow.
 *
 * What is here is the merchant's CONFIGURATION (type, options, return URL,
 * their own reference and metadata) and the provider's VERDICT (status, the
 * failure's code, redaction). What is NOT here, by design: the person's
 * documents, images, names, dates, numbers and addresses — they stay at the
 * provider and `verified_outputs` reads them live — and the provider's hosted
 * `url` and `client_secret`, single-use credentials for the person that a
 * create or retrieve reads fresh.
 *
 * Provider FIRST, row second (unlike a payment): a session the provider
 * refused (Identity not enabled) must not leave an Orbit row nobody can ever
 * complete, and an orphaned provider session moves no money, holds nothing
 * until a person opens its URL, and expires. So `provider_object_id` is
 * NOT NULL from the insert.
 */
export const verificationSessions = pgTable(
  'verification_sessions',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    type: text().notNull(),
    status: text().notNull().default('requires_input'),
    options: jsonb().$type<VerificationOptions>().notNull(),
    returnUrl: text(),
    clientReferenceId: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    /** The last attempt's failure code; the wire's `reason` is Orbit's sentence for it. */
    lastErrorCode: text(),
    /** Whether the last attempt failed at all — a failure whose code Orbit does not know has none. */
    hasLastError: boolean().notNull().default(false),
    redactionStatus: text(),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('verification_sessions_public_id_key').on(table.publicId),
    unique('verification_sessions_id_merchant_id_key').on(table.id, table.merchantId),
    unique('verification_sessions_provider_object_key').on(table.provider, table.providerObjectId),
    index('verification_sessions_merchant_id_idx').on(table.merchantId),
    foreignKey({
      name: 'verification_sessions_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check(
      'verification_sessions_type_check',
      sql.raw(`type in (${inList(VERIFICATION_SESSION_TYPES)})`),
    ),
    check(
      'verification_sessions_status_check',
      sql.raw(`status in (${inList(VERIFICATION_SESSION_STATUSES)})`),
    ),
    check(
      'verification_sessions_last_error_code_check',
      sql.raw(
        `last_error_code is null or last_error_code in (${inList(VERIFICATION_ERROR_CODES)})`,
      ),
    ),
    check(
      'verification_sessions_last_error_check',
      sql`${table.lastErrorCode} is null or ${table.hasLastError}`,
    ),
    check(
      'verification_sessions_redaction_status_check',
      sql.raw(
        `redaction_status is null or redaction_status in (${inList(VERIFICATION_REDACTION_STATUSES)})`,
      ),
    ),
    check('verification_sessions_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check(
      'verification_sessions_metadata_object_check',
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    check(
      'verification_sessions_options_object_check',
      sql`jsonb_typeof(${table.options}) = 'object'`,
    ),
    /** A redacted session keeps no reference the merchant attached to the person. */
    check(
      'verification_sessions_redacted_holds_no_reference_check',
      sql`${table.redactionStatus} is null or (${table.metadata} = '{}'::jsonb and ${table.clientReferenceId} is null)`,
    ),
  ],
);

/**
 * One verification attempt's result (`vr_…`) — each check's OUTCOME and
 * nothing else. The provider's report also carries the person's data and the
 * ids of the images it captured; none of it is a column here, and the adapter
 * never hands it out of `providers/stripe/`.
 */
export const verificationReports = pgTable(
  'verification_reports',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    verificationSessionId: text().notNull(),
    type: text().notNull(),
    options: jsonb().$type<VerificationOptions>().notNull(),
    documentStatus: text(),
    documentErrorCode: text(),
    idNumberStatus: text(),
    idNumberErrorCode: text(),
    selfieStatus: text(),
    selfieErrorCode: text(),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('verification_reports_public_id_key').on(table.publicId),
    unique('verification_reports_provider_object_key').on(table.provider, table.providerObjectId),
    index('verification_reports_merchant_id_idx').on(table.merchantId),
    index('verification_reports_session_id_idx').on(table.verificationSessionId),
    foreignKey({
      name: 'verification_reports_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    /** The session is this merchant's. */
    foreignKey({
      name: 'verification_reports_session_merchant_fkey',
      columns: [table.verificationSessionId, table.merchantId],
      foreignColumns: [verificationSessions.id, verificationSessions.merchantId],
    }).onDelete('restrict'),
    check(
      'verification_reports_type_check',
      sql.raw(`type in (${inList(VERIFICATION_SESSION_TYPES)})`),
    ),
    check(
      'verification_reports_check_status_check',
      sql.raw(
        ['document_status', 'id_number_status', 'selfie_status']
          .map(
            (column) =>
              `(${column} is null or ${column} in (${inList(VERIFICATION_CHECK_STATUSES)}))`,
          )
          .join(' and '),
      ),
    ),
    check(
      'verification_reports_error_code_check',
      sql.raw(
        ['document', 'id_number', 'selfie']
          .map(
            (check) =>
              `(${check}_error_code is null or (${check}_status = 'unverified' and ${check}_error_code in (${inList(VERIFICATION_ERROR_CODES)})))`,
          )
          .join(' and '),
      ),
    ),
    check('verification_reports_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
  ],
);
