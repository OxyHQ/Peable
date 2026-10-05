import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import type { RecurringSnapshot } from '../../services/recurring/contracts';
import { merchants } from './merchants';
import { providerEvents } from './providerEvents';
import { webhookDeliveries } from './webhooks';

/** No public creator. Identity is insert-only; the repository updates observations only. */
export const recurringMirrors = pgTable('recurring_mirrors', {
  id: generatedId(),
  merchantId: text().notNull(),
  oxyAppId: text().notNull(),
  environment: text().notNull(),
  provider: text().notNull(),
  platformAccountId: text().notNull(),
  providerAccountId: text(),
  livemode: boolean().notNull(),
  kind: text().notNull(),
  objectRef: text().notNull(),
  /** Opaque internal provenance reference; no keys, credentials or event metadata. */
  bindingEvidenceRef: text().notNull(),
  snapshot: jsonb().$type<RecurringSnapshot>(),
  revision: integer().notNull().default(0),
  observedAt: timestamptz(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ columns: [table.merchantId, table.oxyAppId, table.environment],
    foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment],
  }).onDelete('restrict').onUpdate('restrict'),
  // Merchant/environment MUST NOT partition this key: one provider object has one owner.
  unique('recurring_mirrors_object_key').on(table.provider, table.platformAccountId,
    table.providerAccountId, table.livemode, table.kind, table.objectRef).nullsNotDistinct(),
  check('recurring_mirrors_provider_check', sql`${table.provider} = 'stripe'`),
  check('recurring_mirrors_kind_check', sql`${table.kind} in ('subscription', 'invoice')`),
  check('recurring_mirrors_mode_check', sql`(${table.environment} = 'production') = ${table.livemode}`),
  check('recurring_mirrors_state_check', sql`(${table.revision} = 0 and ${table.snapshot} is null and ${table.observedAt} is null) or (${table.revision} > 0 and jsonb_typeof(${table.snapshot}) = 'object' and ${table.snapshot} is not null and ${table.observedAt} is not null)`),
]);

/** Internal durable observations only. No dispatcher, public webhook or money operation. */
export const recurringObservationOutbox = pgTable('recurring_observation_outbox', {
  id: generatedId(),
  mirrorId: text().notNull().references(() => recurringMirrors.id, { onDelete: 'restrict' }),
  revision: integer().notNull(),
  deliveryId: text().references(() => webhookDeliveries.id, {onDelete:'restrict'}),
  sourceEventId: text().notNull().references(() => providerEvents.id, { onDelete: 'restrict' }),
  snapshot: jsonb().$type<RecurringSnapshot>().notNull(),
  observedAt: timestamptz().notNull(),
}, (table) => [
  unique('recurring_observation_outbox_revision_key').on(table.mirrorId, table.revision),
  check('recurring_observation_outbox_revision_check', sql`${table.revision} > 0`),
  check('recurring_observation_outbox_snapshot_check', sql`jsonb_typeof(${table.snapshot}) = 'object'`),
]);
