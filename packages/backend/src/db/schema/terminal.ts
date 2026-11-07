import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxy.so/db';
import type { Address } from '@peable.to/shared-types';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import {
  PROVIDER_IDS,
  TERMINAL_READER_ACTION_STATUSES,
  TERMINAL_READER_ACTION_TYPES,
  TERMINAL_READER_STATUSES,
} from './valueSets';

const emptyMetadata = sql`'{}'::jsonb`;

/**
 * A Terminal location (`tml_…`, ADR 0024): where readers are registered and
 * the scope a connection token can be limited to.
 *
 * Provider FIRST, row second (like a verification session, unlike a payment):
 * a location the provider refused (Terminal not enabled) must not leave an
 * Orbit row nobody can register a reader to, and an orphaned provider location
 * moves no money. So `provider_object_id` is NOT NULL from the insert.
 * `livemode` is the merchant's, read in the statement (ADR 0017).
 */
export const terminalLocations = pgTable(
  'terminal_locations',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    displayName: text().notNull(),
    /** The wire `Address` (`country` always set). */
    address: jsonb().$type<Address>().notNull(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('terminal_locations_public_id_key').on(table.publicId),
    unique('terminal_locations_id_merchant_id_key').on(table.id, table.merchantId),
    unique('terminal_locations_provider_object_key').on(table.provider, table.providerObjectId),
    index('terminal_locations_merchant_id_idx').on(table.merchantId),
    foreignKey({
      name: 'terminal_locations_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check('terminal_locations_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check(
      'terminal_locations_address_country_check',
      sql`jsonb_typeof(${table.address}) = 'object' and ${table.address} ->> 'country' ~ '^[A-Z]{2}$'`,
    ),
    check(
      'terminal_locations_metadata_object_check',
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  ],
);

/**
 * A Terminal reader (`tmr_…`, ADR 0024), registered at the provider first and
 * bound to one of the SAME merchant's locations (a composite key).
 *
 * The `action_*` columns are the one reader action Orbit drives — collecting
 * a card_present PaymentIntent — and they move only by compare-and-swap
 * (`db/terminal/terminalRepository.ts`): `in_progress` is written when Orbit
 * hands the provider the collection, and the provider's reader read decides
 * `succeeded` / `failed`, once, with its Orbit event in the same transaction.
 * `action_failure_code` is the provider's CODE; the wire's message is Orbit's
 * sentence for it, never the provider's prose. `action_payment_intent_id` is
 * the internal id of a payment of the same merchant (checked by the writer:
 * `payment_intents` has no `(id, merchant_id)` key to make it structural).
 */
export const terminalReaders = pgTable(
  'terminal_readers',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    locationId: text().notNull(),
    label: text().notNull(),
    deviceType: text().notNull(),
    serialNumber: text().notNull(),
    /** As the provider last reported it; refreshed on a retrieve. */
    status: text(),
    lastSeenAt: timestamp({ withTimezone: true, mode: 'date' }),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    actionType: text(),
    actionStatus: text(),
    actionPaymentIntentId: text(),
    actionEnableCustomerCancellation: boolean(),
    actionFailureCode: text(),
    /** When Orbit claimed the reader for this action (before asking the provider). */
    actionStartedAt: timestamp({ withTimezone: true, mode: 'date' }),
    /**
     * When the provider accepted it. A provider read is applied to an action
     * only once acknowledged: before that, the reader's previous attempt is
     * still what the provider shows.
     */
    actionAcknowledgedAt: timestamp({ withTimezone: true, mode: 'date' }),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('terminal_readers_public_id_key').on(table.publicId),
    unique('terminal_readers_provider_object_key').on(table.provider, table.providerObjectId),
    index('terminal_readers_merchant_id_idx').on(table.merchantId),
    index('terminal_readers_location_id_idx').on(table.locationId),
    index('terminal_readers_action_payment_intent_id_idx').on(table.actionPaymentIntentId),
    foreignKey({
      name: 'terminal_readers_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    /** The location is this merchant's; a location with readers cannot be deleted. */
    foreignKey({
      name: 'terminal_readers_location_merchant_fkey',
      columns: [table.locationId, table.merchantId],
      foreignColumns: [terminalLocations.id, terminalLocations.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'terminal_readers_action_payment_intent_fkey',
      columns: [table.actionPaymentIntentId],
      foreignColumns: [paymentIntents.id],
    }).onDelete('restrict'),
    check('terminal_readers_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check(
      'terminal_readers_status_check',
      sql.raw(`status is null or status in (${inList(TERMINAL_READER_STATUSES)})`),
    ),
    check(
      'terminal_readers_metadata_object_check',
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    /** An action is whole or absent: its type, status, payment and configuration together. */
    check(
      'terminal_readers_action_shape_check',
      sql.raw(
        `(action_type is null and action_status is null and action_payment_intent_id is null and action_enable_customer_cancellation is null and action_failure_code is null and action_started_at is null and action_acknowledged_at is null) or (action_type in (${inList(TERMINAL_READER_ACTION_TYPES)}) and action_status in (${inList(TERMINAL_READER_ACTION_STATUSES)}) and action_payment_intent_id is not null and action_enable_customer_cancellation is not null and action_started_at is not null and (action_failure_code is null or action_status = 'failed'))`,
      ),
    ),
  ],
);
