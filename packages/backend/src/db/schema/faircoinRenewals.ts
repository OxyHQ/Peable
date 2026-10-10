import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import type {
  BillingFaircoinRenewalConsent,
  BillingFaircoinRenewalRevocation,
} from '@peable.to/shared-types';
import type {
  FaircoinRenewalInstruction,
  FaircoinRenewalExecution,
} from '../../services/billing/faircoin-renewal';
import { merchants } from './merchants';

/** Verified scheduling consent only. No seeds, keys, mandates or transfer data. */
export const faircoinRenewalAuthorizations = pgTable(
  'faircoin_renewal_authorizations',
  {
    id: generatedId(),
    merchantId: text().notNull(),
    oxyAppId: text().notNull(),
    environment: text().notNull(),
    namespaceDigest: text().notNull(),
    authorizationRef: text().notNull(),
    consent: jsonb().$type<BillingFaircoinRenewalConsent>().notNull(),
    revocation: jsonb().$type<BillingFaircoinRenewalRevocation>(),
    instructions: jsonb().$type<FaircoinRenewalInstruction[]>().notNull().default([]),
    executions: jsonb().$type<FaircoinRenewalExecution[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: 'faircoin_renewal_merchant_identity_fk',
      columns: [table.merchantId, table.oxyAppId, table.environment],
      foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('faircoin_renewal_namespace_authorization_key').on(
      table.namespaceDigest,
      table.authorizationRef,
    ),
    check('faircoin_renewal_namespace_check', sql`${table.namespaceDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'faircoin_renewal_consent_mode_check',
      sql`(${table.environment} = 'production') = (${table.consent}->>'mode' = 'live')`,
    ),
    check(
      'faircoin_renewal_consent_environment_check',
      sql`${table.environment} = ${table.consent}->>'environment'`,
    ),
    check(
      'faircoin_renewal_execution_array_check',
      sql`jsonb_typeof(${table.executions}) = 'array'`,
    ),
    check(
      'faircoin_renewal_instruction_array_check',
      sql`jsonb_typeof(${table.instructions}) = 'array'`,
    ),
  ],
);
