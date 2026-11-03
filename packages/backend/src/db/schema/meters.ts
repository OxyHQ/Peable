import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxy.so/db';
import { merchants } from './merchants';
import { METER_AGGREGATIONS, METER_STATUSES } from './valueSets';

/** A usage meter (`mtr_…`). One ACTIVE meter per event name per merchant. */
export const billingMeters = pgTable(
  'billing_meters',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    displayName: text().notNull(),
    eventName: text().notNull(),
    aggregation: text().notNull(),
    customerPayloadKey: text().notNull().default('peable_customer_id'),
    valuePayloadKey: text().notNull().default('value'),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('billing_meters_public_id_key').on(table.publicId),
    unique('billing_meters_id_merchant_id_key').on(table.id, table.merchantId),
    uniqueIndex('billing_meters_merchant_active_event_key')
      .on(table.merchantId, table.eventName)
      .where(sql`${table.status} = 'active'`),
    index('billing_meters_merchant_id_id_idx').on(table.merchantId, table.id),
    check(
      'billing_meters_aggregation_check',
      sql.raw(`aggregation in (${inList(METER_AGGREGATIONS)})`),
    ),
    check('billing_meters_status_check', sql.raw(`status in (${inList(METER_STATUSES)})`)),
    check(
      'billing_meters_names_check',
      sql.raw(
        `char_length(display_name) between 1 and 250 and event_name ~ '^[A-Za-z0-9_.:-]{1,100}$' and customer_payload_key ~ '^[A-Za-z0-9_]{1,100}$' and value_payload_key ~ '^[A-Za-z0-9_]{1,100}$' and customer_payload_key <> value_payload_key`,
      ),
    ),
  ],
);
