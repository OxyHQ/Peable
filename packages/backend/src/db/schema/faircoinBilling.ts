import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from '@oxy.so/db';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import type { BillingTaxCheckoutSnapshot } from '../../services/billing/tax-checkout';
import type { FaircoinFxQuote } from '../../services/billing/faircoin-fx';

/** Native, manually renewed periods. No payer private key or automatic debit. */
export const faircoinBillingSubscriptions = pgTable(
  'faircoin_billing_subscriptions',
  {
    id: text().primaryKey(),
    merchantId: text().notNull(),
    oxyAppId: text().notNull(),
    environment: text().notNull(),
    subjectRef: text().notNull(),
    planRef: text().notNull(),
    priceRef: text().notNull(),
    billingInterval: text({ enum: ['month', 'year'] })
      .notNull()
      .default('month'),
    customerRef: text().notNull(),
    initialKey: text().notNull(),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    cancelledAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'faircoin_billing_owner_fk',
      columns: [t.merchantId, t.oxyAppId, t.environment],
      foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment],
    }).onDelete('restrict'),
    check('faircoin_billing_interval', sql`${t.billingInterval} IN ('month', 'year')`),
    unique('faircoin_billing_initial_key').on(t.merchantId, t.initialKey),
    uniqueIndex('faircoin_billing_live_subject_plan')
      .on(t.merchantId, t.subjectRef, t.planRef)
      .where(sql`${t.cancelAtPeriodEnd} = false`),
  ],
);
export const faircoinBillingInvoices = pgTable(
  'faircoin_billing_invoices',
  {
    id: text().primaryKey(),
    subscriptionId: text()
      .notNull()
      .references(() => faircoinBillingSubscriptions.id, { onDelete: 'restrict' }),
    checkoutRef: text().notNull().unique(),
    operationKey: text().notNull(),
    requestDigest: text().notNull(),
    taxSnapshot: jsonb().$type<BillingTaxCheckoutSnapshot>().notNull(),
    fxQuote: jsonb().$type<FaircoinFxQuote>().notNull(),
    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),
    paymentIntentId: text()
      .unique()
      .references(() => paymentIntents.id, { onDelete: 'restrict' }),
    /** First verified chain/mempool observation of the full payment; never a caller-reported hash. */
    acceptedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('faircoin_billing_single_use_tax_quote').on(
      sql`(${t.taxSnapshot}->'taxQuote'->'quote'->>'id')`,
    ),
    unique('faircoin_billing_invoice_operation').on(t.subscriptionId, t.operationKey),
    unique('faircoin_billing_invoice_period').on(t.subscriptionId, t.periodStart),
    check('faircoin_billing_positive_period', sql`${t.periodEnd} > ${t.periodStart}`),
    check('faircoin_billing_usd_quote', sql`${t.fxQuote}->>'currency' = 'USD'`),
  ],
);
