import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { merchants } from './merchants';
import { TEST_CLOCK_STATUSES } from './valueSets';

/**
 * A test clock (`clock_…`): test mode only — a CHECK cannot read the
 * merchant's mode, so `insertTestClock` refuses a live merchant (the one
 * writer). Everything attached to it reads `frozen_time` as "now".
 */
export const testClocks = pgTable(
  'test_clocks',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    name: text(),
    frozenTime: timestamptz().notNull(),
    status: text().notNull().default('ready'),
    deletesAfter: timestamptz().notNull(),
    /** A deleted clock keeps its row (subscriptions and invoices name it). */
    deletedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('test_clocks_public_id_key').on(table.publicId),
    unique('test_clocks_id_merchant_id_key').on(table.id, table.merchantId),
    index('test_clocks_merchant_id_id_idx').on(table.merchantId, table.id),
    check('test_clocks_status_check', sql.raw(`status in (${inList(TEST_CLOCK_STATUSES)})`)),
    check('test_clocks_name_check', sql.raw(`name is null or char_length(name) between 1 and 300`)),
  ],
);
