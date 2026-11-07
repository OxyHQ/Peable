import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import type { BillingDetails, CardDetails } from '@peable.to/shared-types';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import { BASE_UNIT_STRING_PATTERN, CURRENCY_CODES } from './valueSets';

/** What a provider said about a charge's authorization, in Peable's keys. */
export interface StoredChargeOutcome {
  readonly networkStatus: string | null;
  readonly riskLevel: string | null;
  /** 0–100, when the provider scored it; absent on a snapshot read before ADR 0022. */
  readonly riskScore?: number | null;
  /** The provider's reason code (`highest_risk_level`, …); absent before ADR 0022. */
  readonly reason?: string | null;
  readonly type: string | null;
}

/**
 * A Charge (`ch_…`) — the read-only record of the authorization a CARD
 * PaymentIntent obtained (ADR 0019).
 *
 * ONE per payment intent, written in the same transaction that first moves a
 * card intent to `requires_capture` or `succeeded` (`services/intentTransition.ts`).
 * Peable does not model failed attempts as charges: why an attempt failed is
 * the intent's `last_payment_error`. The provider's charge id stays where it
 * already is — `payment_intents.provider_charge_id`, the binding transfers read —
 * and is never serialized (ADR 0016).
 *
 * `outcome`, `billing_details` and `payment_method_details` are a snapshot of what the provider
 * reports, filled after the transition by a provider read (`services/charges.ts`)
 * and refreshed by `charge.*` provider events: NULL means "not read yet", never
 * "nothing to say". `amount_refunded` is not stored — it is the sum of
 * succeeded refunds, read in the same statement as the row.
 */
export const charges = pgTable(
  'charges',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    paymentIntentId: text().notNull(),
    /** The authorized amount. */
    amount: text().notNull(),
    /** What was captured: `"0"` while the authorization is held. */
    amountCaptured: text().notNull().default('0'),
    currency: text().notNull(),
    outcome: jsonb().$type<StoredChargeOutcome>(),
    paymentMethodDetails: jsonb().$type<{ type: 'card'; card: CardDetails }>(),
    /** The billing details the provider reported for the charge (Stripe's `billing_details`). */
    billingDetails: jsonb().$type<BillingDetails>(),
    /** When the provider snapshot above was last read. */
    syncedAt: timestamptz(),
    /**
     * When the merchant's risk rules judged this charge after authorization
     * (ADR 0022 D3) — the once-per-charge CLAIM, set by one guarded UPDATE.
     */
    radarEvaluatedAt: timestamptz(),
    /**
     * When the judge sweep last tried this unjudged charge: its backoff and its
     * order, so a charge that keeps failing goes to the back of the queue.
     */
    radarJudgeAttemptedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('charges_public_id_key').on(table.publicId),
    /** One charge per payment: the authorization that succeeded. */
    unique('charges_payment_intent_id_key').on(table.paymentIntentId),
    foreignKey({
      name: 'charges_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'charges_payment_intent_id_fkey',
      columns: [table.paymentIntentId],
      foreignColumns: [paymentIntents.id],
    }).onDelete('restrict'),
    check('charges_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    check(
      'charges_amount_captured_check',
      sql.raw(`amount_captured ~ '${BASE_UNIT_STRING_PATTERN}'`),
    ),
    check(
      'charges_captured_within_amount_check',
      sql`${table.amountCaptured}::numeric <= ${table.amount}::numeric`,
    ),
    check('charges_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'charges_billing_details_object_check',
      sql`${table.billingDetails} is null or jsonb_typeof(${table.billingDetails}) = 'object'`,
    ),
    /** Every charge search and list walks `merchant_id = … order by id desc` (`db/search`). */
    index('charges_merchant_id_id_idx').on(table.merchantId, table.id),
    /** The judge sweep's queue (ADR 0022 D3): only the unjudged charges. */
    index('charges_radar_unjudged_idx')
      .on(table.radarJudgeAttemptedAt, table.createdAt)
      .where(sql`${table.radarEvaluatedAt} is null`),
  ],
);
