import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import type {
  Address,
  BillingDetails,
  CardDetails,
  CheckoutLocale,
  Shipping,
} from '@peable.to/shared-types';
import { merchants } from './merchants';
import { testClocks } from './testClocks';
import {
  CHECKOUT_LOCALES,
  CURRENCY_CODES,
  PROVIDER_IDS,
  SIGNED_BASE_UNIT_STRING_PATTERN,
} from './valueSets';

const emptyMetadata = sql`'{}'::jsonb`;

/**
 * `payment_methods`' columns, typed by hand: the two tables reference each
 * other, and naming the later one inside the earlier one's definition is a
 * circular type TypeScript cannot infer. Called lazily, after both exist.
 */
function paymentMethodColumns(): { id: AnyPgColumn; customerId: AnyPgColumn } {
  return { id: paymentMethods.id, customerId: paymentMethods.customerId };
}

/**
 * A Customer (`cus_…`) — Orbit's own object (ADR 0016).
 *
 * The row is the source of truth for what the merchant told Orbit; a provider
 * customer is a BINDING in `customer_provider_bindings`, created lazily, per
 * mode, the first time a card payment method is attached — never serialized.
 *
 * **Deletion is a tombstone (`deleted_at`), not a `DELETE`.** Payment intents
 * and payment methods reference a customer with `restrict` (the money graph),
 * and Stripe's own delete keeps the object retrievable as `deleted: true`. A
 * deleted customer is invisible to every list and to every create that names
 * it, and its payment methods are detached in the same transaction.
 */
export const customers = pgTable(
  'customers',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    email: text(),
    name: text(),
    phone: text(),
    description: text(),
    address: jsonb().$type<Address>(),
    shipping: jsonb().$type<Shipping>(),
    /**
     * Stripe's `preferred_locales`: most preferred first, each once, from the
     * payer locale set (`CHECKOUT_LOCALES`). The customer emails are written in
     * the first; Checkout fills it for a customer it creates.
     */
    preferredLocales: text().array().$type<CheckoutLocale[]>().notNull().default(sql`'{}'::text[]`),
    /** `invoice_settings.default_payment_method` — one of THIS customer's attached methods. */
    defaultPaymentMethodId: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    /**
     * SIGNED base units (ADR 0018): negative is credit the customer holds.
     * Written only by `recordBalanceTransaction`, which appends the ledger row
     * (`customer_balance_transactions`) in the same statement's transaction.
     */
    balance: text().notNull().default('0'),
    /** The billing currency, fixed by the first balance movement, subscription or invoice. */
    currency: text(),
    /** Test mode only; set at creation and never changed. */
    testClockId: text(),
    deletedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('customers_public_id_key').on(table.publicId),
    /** The target of every same-merchant composite reference to a customer. */
    unique('customers_id_merchant_id_key').on(table.id, table.merchantId),
    index('customers_merchant_id_idx').on(table.merchantId),
    /** `GET /v1/customers?email=` — exact match, Stripe's semantics. */
    index('customers_merchant_id_email_idx').on(table.merchantId, table.email),
    /** `GET /v1/customers/search?query=email:"…"` — case-insensitive, Stripe's semantics. */
    index('customers_merchant_id_lower_email_idx').on(table.merchantId, sql`lower(${table.email})`),
    foreignKey({
      name: 'customers_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    /**
     * The default is one of this customer's OWN methods: the reference carries
     * the customer id, so a method attached to someone else cannot be named.
     */
    foreignKey({
      name: 'customers_default_payment_method_fkey',
      columns: [table.defaultPaymentMethodId, table.id],
      foreignColumns: [paymentMethodColumns().id, paymentMethodColumns().customerId],
    }).onDelete('restrict'),
    check('customers_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    foreignKey({
      name: 'customers_test_clock_fkey',
      columns: [table.testClockId, table.merchantId],
      foreignColumns: [testClocks.id, testClocks.merchantId],
    }).onDelete('restrict'),
    /** A balance has a currency; a currency is one the gateway denominates in. */
    check(
      'customers_balance_check',
      sql.raw(
        `balance ~ '${SIGNED_BASE_UNIT_STRING_PATTERN}' and (balance = '0' or currency is not null) and (currency is null or currency in (${CURRENCY_CODES.map((code) => `'${code}'`).join(', ')}))`,
      ),
    ),
    check(
      'customers_address_object_check',
      sql`${table.address} is null or jsonb_typeof(${table.address}) = 'object'`,
    ),
    check(
      'customers_shipping_object_check',
      sql`${table.shipping} is null or jsonb_typeof(${table.shipping}) = 'object'`,
    ),
    /**
     * At most every locale once, no NULL element, only the payer locale set.
     * Uniqueness is the contract's (a CHECK cannot compare array elements
     * without a subquery); the bound keeps a duplicate list finite.
     */
    check(
      'customers_preferred_locales_check',
      sql.raw(
        `cardinality(preferred_locales) <= ${CHECKOUT_LOCALES.length} and array_position(preferred_locales, null) is null and preferred_locales <@ ARRAY[${inList(CHECKOUT_LOCALES)}]::text[]`,
      ),
    ),
    check(
      'customers_email_length_check',
      sql`${table.email} is null or length(${table.email}) between 1 and 512`,
    ),
    /** A tombstone names no default: deleting detaches every method. */
    check(
      'customers_deleted_has_no_default_check',
      sql`${table.deletedAt} is null or ${table.defaultPaymentMethodId} is null`,
    ),
  ],
);

/**
 * A PaymentMethod (`pm_…`) — Peable's wrapper over a provider payment method
 * (ADR 0016). Card details are collected by the provider's own Elements in the
 * browser; Peable stores only what is safe to show (`card`) and the binding.
 *
 * `customer_id` is NULL once detached — Stripe's model: a detached method can
 * never be used again, and it stays readable. The provider object is unique per
 * provider, so one provider payment method can be registered only once.
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    customerId: text(),
    type: text().notNull().default('card'),
    card: jsonb().$type<CardDetails>().notNull(),
    billingDetails: jsonb().$type<BillingDetails>().notNull(),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    detachedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('payment_methods_public_id_key').on(table.publicId),
    unique('payment_methods_id_merchant_id_key').on(table.id, table.merchantId),
    unique('payment_methods_id_customer_id_key').on(table.id, table.customerId),
    uniqueIndex('payment_methods_provider_object_key').on(table.provider, table.providerObjectId),
    index('payment_methods_customer_id_idx').on(table.customerId),
    foreignKey({
      name: 'payment_methods_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    /** The customer is this merchant's. */
    foreignKey({
      name: 'payment_methods_customer_merchant_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    check('payment_methods_type_check', sql`${table.type} in ('card')`),
    check('payment_methods_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check('payment_methods_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    /** A detached method names no customer, and is never attached again. */
    check(
      'payment_methods_detached_has_no_customer_check',
      sql`${table.detachedAt} is null or ${table.customerId} is null`,
    ),
  ],
);

/**
 * A customer's provider object — the BINDING (ADR 0016 D2), never serialized.
 *
 * Created lazily the first time a card payment method is attached to the
 * customer. Its mode is the customer's merchant's (ADR 0017: a row's mode lives
 * in `merchants.livemode` alone), so an operation on it resolves the provider
 * of that mode. One per (customer, provider); a provider customer belongs to
 * exactly one Peable customer.
 */
export const customerProviderBindings = pgTable(
  'customer_provider_bindings',
  {
    id: generatedId(),
    customerId: text().notNull(),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('customer_provider_bindings_customer_provider_key').on(table.customerId, table.provider),
    unique('customer_provider_bindings_provider_object_key').on(
      table.provider,
      table.providerObjectId,
    ),
    foreignKey({
      name: 'customer_provider_bindings_customer_id_fkey',
      columns: [table.customerId],
      foreignColumns: [customers.id],
    }).onDelete('restrict'),
    check(
      'customer_provider_bindings_provider_check',
      sql.raw(`provider in (${inList(PROVIDER_IDS)})`),
    ),
  ],
);
