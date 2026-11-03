import { sql } from 'drizzle-orm';
import {
  CURRENCY_CODES,
  PAYMENT_INTENT_STATUSES,
  PRICE_TYPES,
  REFUND_REASONS,
} from '@peable.to/shared-types';
import type { SearchFields } from '../../lib/search/compile';
import { charges, customers, paymentIntents, prices, products, refunds } from '../schema';
import { REFUND_STATUSES } from '../schema/valueSets';

/**
 * What each searchable resource exposes to `GET /v1/<objects>/search`
 * (`lib/search/compile.ts` has the types and the predicates they compile to).
 *
 * The names are Stripe's for the same resource wherever Stripe has one, so a
 * query written against Stripe's Search API runs here unchanged; a field Stripe
 * lacks is a Peable addition and says so. Every expression reads the ROW's own
 * table (or a scalar subquery keyed by it, written table-qualified as
 * CONVENTIONS.md requires); the merchant predicate is the repository's.
 *
 * ## Adding a resource
 *
 * One map here and one entry in `lib/search/resources.ts` — the subscriptions
 * and invoices of the billing engine (ADR 0018) are exactly that: declare
 * `status`, `customer`, `created`, `metadata` (and Stripe's
 * `invoices`: `total`, `number`, `subscription`), give the repository's list
 * function a `search` predicate and a count, and register it. The parser, the
 * page token, the routes, the dashboard search and the SDK need no change.
 */

/** The internal key of `cus_…` in the caller's merchant, or NULL. */
const customerKey = (publicId: string, merchantId: string) =>
  sql`select ${customers.id} from ${customers} where ${customers.publicId} = ${publicId}::text and ${customers.merchantId} = ${merchantId}::text`;

const intentKey = (publicId: string, merchantId: string) =>
  sql`select ${paymentIntents.id} from ${paymentIntents} where ${paymentIntents.publicId} = ${publicId}::text and ${paymentIntents.merchantId} = ${merchantId}::text`;

const productKey = (publicId: string, merchantId: string) =>
  sql`select ${products.id} from ${products} where ${products.publicId} = ${publicId}::text and ${products.merchantId} = ${merchantId}::text`;

/** A charge's own intent, by the charge's reference — raw and qualified. */
const ofChargeIntent = (expression: string) =>
  sql.raw(
    `(select ${expression} from payment_intents p where p.id = "charges"."payment_intent_id")`,
  );

/** Stripe's PaymentIntent search fields, plus `description` and `receipt_email`. */
export const PAYMENT_INTENT_SEARCH_FIELDS: SearchFields = {
  amount: { type: 'amount', sql: paymentIntents.amount },
  currency: {
    type: 'token',
    sql: paymentIntents.currency,
    values: CURRENCY_CODES,
    case: 'upper',
    nullable: false,
  },
  customer: {
    type: 'reference',
    sql: paymentIntents.customerId,
    prefix: 'cus',
    resolve: customerKey,
    nullable: true,
  },
  status: {
    type: 'token',
    sql: paymentIntents.status,
    values: PAYMENT_INTENT_STATUSES,
    case: 'lower',
    nullable: false,
  },
  created: { type: 'timestamp', sql: paymentIntents.createdAt },
  metadata: { type: 'metadata', sql: paymentIntents.metadata },
  // Peable additions: what the dashboard's free-text search matches a payment by.
  description: { type: 'string', sql: paymentIntents.description, nullable: true },
  receipt_email: { type: 'string', sql: paymentIntents.receiptEmail, nullable: true },
};

/**
 * Stripe's Charge search fields. A charge's `customer` and `metadata` are its
 * intent's, and `refunded` / `disputed` are derived exactly as `toChargeDTO`
 * derives them — `searchFields.realdb.test.ts` holds the two to the same answer.
 */
export const CHARGE_SEARCH_FIELDS: SearchFields = {
  amount: { type: 'amount', sql: charges.amount },
  currency: {
    type: 'token',
    sql: charges.currency,
    values: CURRENCY_CODES,
    case: 'upper',
    nullable: false,
  },
  customer: {
    type: 'reference',
    sql: ofChargeIntent('p.customer_id'),
    prefix: 'cus',
    resolve: customerKey,
    nullable: true,
  },
  payment_intent: {
    type: 'reference',
    sql: charges.paymentIntentId,
    prefix: 'pi',
    resolve: intentKey,
    nullable: false,
  },
  // Peable records only the authorization that succeeded (ADR 0019), so every
  // charge is `succeeded`; Stripe's other two values are accepted and match none.
  status: {
    type: 'token',
    sql: sql`'succeeded'::text`,
    values: ['succeeded', 'pending', 'failed'],
    case: 'lower',
    nullable: false,
  },
  captured: { type: 'boolean', sql: sql`${charges.amountCaptured} <> '0'` },
  refunded: {
    type: 'boolean',
    sql: sql.raw(
      `case when "charges"."amount_captured" = '0'
        then coalesce((select p.status from payment_intents p where p.id = "charges"."payment_intent_id") = 'canceled', false)
        else (select coalesce(sum(r.amount::numeric), 0) from refunds r where r.payment_intent_id = "charges"."payment_intent_id" and r.status = 'succeeded') >= "charges"."amount_captured"::numeric
      end`,
    ),
  },
  disputed: {
    type: 'boolean',
    sql: sql.raw(
      `exists (select 1 from disputes d where d.payment_intent_id = "charges"."payment_intent_id")`,
    ),
  },
  'billing_details.email': {
    type: 'string',
    sql: sql`${charges.billingDetails} ->> 'email'`,
    nullable: true,
  },
  'billing_details.name': {
    type: 'string',
    sql: sql`${charges.billingDetails} ->> 'name'`,
    nullable: true,
  },
  'billing_details.address.postal_code': {
    type: 'string',
    sql: sql`${charges.billingDetails} -> 'address' ->> 'postal_code'`,
    nullable: true,
    substring: false,
  },
  'payment_method_details.card.last4': {
    type: 'string',
    sql: sql`${charges.paymentMethodDetails} -> 'card' ->> 'last4'`,
    nullable: true,
    substring: false,
  },
  'payment_method_details.card.brand': {
    type: 'string',
    sql: sql`${charges.paymentMethodDetails} -> 'card' ->> 'brand'`,
    nullable: true,
    substring: false,
  },
  created: { type: 'timestamp', sql: charges.createdAt },
  metadata: { type: 'metadata', sql: ofChargeIntent('p.metadata') },
};

/** Stripe's Customer search fields. A deleted customer is never found (the repository's scope). */
export const CUSTOMER_SEARCH_FIELDS: SearchFields = {
  email: { type: 'string', sql: customers.email, nullable: true },
  name: { type: 'string', sql: customers.name, nullable: true },
  phone: { type: 'string', sql: customers.phone, nullable: true },
  created: { type: 'timestamp', sql: customers.createdAt },
  metadata: { type: 'metadata', sql: customers.metadata },
};

/** Stripe's Product search fields. */
export const PRODUCT_SEARCH_FIELDS: SearchFields = {
  name: { type: 'string', sql: products.name, nullable: false },
  active: { type: 'boolean', sql: products.active },
  description: { type: 'string', sql: products.description, nullable: true },
  url: { type: 'string', sql: products.url, nullable: true },
  created: { type: 'timestamp', sql: products.createdAt },
  metadata: { type: 'metadata', sql: products.metadata },
};

/** Stripe's Price search fields. */
export const PRICE_SEARCH_FIELDS: SearchFields = {
  active: { type: 'boolean', sql: prices.active },
  currency: {
    type: 'token',
    sql: prices.currency,
    values: CURRENCY_CODES,
    case: 'upper',
    nullable: false,
  },
  product: {
    type: 'reference',
    sql: prices.productId,
    prefix: 'prod',
    resolve: productKey,
    nullable: false,
  },
  type: { type: 'token', sql: prices.type, values: PRICE_TYPES, case: 'lower', nullable: false },
  lookup_key: { type: 'string', sql: prices.lookupKey, nullable: true },
  created: { type: 'timestamp', sql: prices.createdAt },
  metadata: { type: 'metadata', sql: prices.metadata },
};

/** Refunds — a Peable addition: Stripe has no refund search. Stripe's field names. */
export const REFUND_SEARCH_FIELDS: SearchFields = {
  amount: { type: 'amount', sql: refunds.amount },
  currency: {
    type: 'token',
    sql: refunds.currency,
    values: CURRENCY_CODES,
    case: 'upper',
    nullable: false,
  },
  status: {
    type: 'token',
    sql: refunds.status,
    values: REFUND_STATUSES,
    case: 'lower',
    nullable: false,
  },
  reason: {
    type: 'token',
    sql: refunds.reason,
    values: REFUND_REASONS,
    case: 'lower',
    nullable: true,
  },
  payment_intent: {
    type: 'reference',
    sql: refunds.paymentIntentId,
    prefix: 'pi',
    resolve: intentKey,
    nullable: false,
  },
  created: { type: 'timestamp', sql: refunds.createdAt },
  metadata: { type: 'metadata', sql: refunds.metadata },
};
