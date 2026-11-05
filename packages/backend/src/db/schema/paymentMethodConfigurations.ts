import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxy.so/db';
import type { PaymentMethodConfigurationType } from '@peable.to/shared-types';
import { merchants } from './merchants';
import { PAYMENT_METHOD_DOMAIN_WALLET_STATUSES, PROVIDER_IDS } from './valueSets';

/**
 * Which payment methods a merchant's card-rail payers are offered (`pmc_…`).
 *
 * Orbit's row (ADR 0016); the provider's payment method configuration is a
 * binding (`payment_method_configuration_bindings`), created and brought up to
 * date lazily the first time a payment needs it, per mode.
 *
 * `preferences` holds only the merchant's EXPLICIT choices (`{type: 'on'|'off'}`)
 * and never `faircoin`, which is locked on (ADR 0021 D2) and has no choice to
 * store; a type absent from it follows Orbit's default (`services/paymentMethods/
 * configuration.ts`). Stored as the choices rather than the effective set, so a
 * default Orbit changes later reaches every merchant who never chose, and a
 * merchant who did choose keeps their choice.
 *
 * `version` is bumped by every change and is the compare half of the binding's
 * `synced_version`: a binding behind its row is pushed again before a payment
 * uses it, so the provider never offers a method the merchant turned off.
 */
export const paymentMethodConfigurations = pgTable(
  'payment_method_configurations',
  {
    id: generatedId(),
    /** `pmc_…`. */
    publicId: text().notNull(),
    merchantId: text().notNull(),
    name: text().notNull(),
    active: boolean().notNull().default(true),
    isDefault: boolean().notNull().default(false),
    preferences: jsonb()
      .$type<Partial<Record<Exclude<PaymentMethodConfigurationType, 'faircoin'>, 'on' | 'off'>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('payment_method_configurations_public_id_key').on(table.publicId),
    /** The target of `payment_intents`' same-merchant reference. */
    unique('payment_method_configurations_id_merchant_id_key').on(table.id, table.merchantId),
    index('payment_method_configurations_merchant_id_idx').on(table.merchantId),
    /**
     * Exactly one default per merchant — the configuration a payment uses when
     * it names none. Partial, so any number of non-defaults sit beside it; the
     * lazy creation of the default converges here when two requests race.
     */
    uniqueIndex('payment_method_configurations_one_default_key')
      .on(table.merchantId)
      .where(sql`${table.isDefault}`),
    foreignKey({
      name: 'payment_method_configurations_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check(
      'payment_method_configurations_preferences_object_check',
      sql`jsonb_typeof(${table.preferences}) = 'object'`,
    ),
    // A default that could be switched off would leave payments with nothing to use.
    check(
      'payment_method_configurations_default_is_active_check',
      sql`not ${table.isDefault} or ${table.active}`,
    ),
    check('payment_method_configurations_name_check', sql`length(${table.name}) between 1 and 100`),
    check('payment_method_configurations_version_check', sql`${table.version} >= 1`),
  ],
);

/**
 * The provider's configuration behind one of Orbit's — ADR 0016 D2's binding,
 * never serialized. One per (configuration, provider); its mode is the
 * merchant's (ADR 0017). `synced_version` is the row version the provider last
 * accepted.
 */
export const paymentMethodConfigurationBindings = pgTable(
  'payment_method_configuration_bindings',
  {
    id: generatedId(),
    configurationId: text().notNull(),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    syncedVersion: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('payment_method_configuration_bindings_config_provider_key').on(
      table.configurationId,
      table.provider,
    ),
    unique('payment_method_configuration_bindings_provider_object_key').on(
      table.provider,
      table.providerObjectId,
    ),
    foreignKey({
      name: 'payment_method_configuration_bindings_configuration_id_fkey',
      columns: [table.configurationId],
      foreignColumns: [paymentMethodConfigurations.id],
    }).onDelete('restrict'),
    check(
      'payment_method_configuration_bindings_provider_check',
      sql.raw(`provider in (${inList(PROVIDER_IDS)})`),
    ),
  ],
);

/**
 * A web domain a merchant serves payment pages from (`pmd_…`), registered at
 * the provider so Apple Pay and Google Pay run there.
 *
 * The provider registration is created in the same request, so its binding is
 * inline (`provider`, `provider_object_id`) like a dispute's; the wallets'
 * standing is the provider's answer, re-read by `…/validate`.
 *
 * One domain per merchant once (`merchant_id, domain_name`). Across merchants
 * the provider is the arbiter: Peable holds one account per mode, a domain is
 * registered there once, and a second merchant naming it converges on the
 * same provider object — which `provider_object_key` refuses, so a domain is
 * never shared between two merchants' wallets.
 */
export const paymentMethodDomains = pgTable(
  'payment_method_domains',
  {
    id: generatedId(),
    /** `pmd_…`. */
    publicId: text().notNull(),
    merchantId: text().notNull(),
    /** Lowercase hostname; validated by the one writer and by the CHECK below. */
    domainName: text().notNull(),
    enabled: boolean().notNull().default(true),
    applePayStatus: text().notNull().default('inactive'),
    /** Peable's words for why Apple Pay is inactive, never the provider's prose. */
    applePayError: text(),
    googlePayStatus: text().notNull().default('inactive'),
    googlePayError: text(),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('payment_method_domains_public_id_key').on(table.publicId),
    unique('payment_method_domains_merchant_domain_key').on(table.merchantId, table.domainName),
    unique('payment_method_domains_provider_object_key').on(table.provider, table.providerObjectId),
    foreignKey({
      name: 'payment_method_domains_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check(
      'payment_method_domains_provider_check',
      sql.raw(`provider in (${inList(PROVIDER_IDS)})`),
    ),
    check(
      'payment_method_domains_apple_pay_status_check',
      sql.raw(`apple_pay_status in (${inList(PAYMENT_METHOD_DOMAIN_WALLET_STATUSES)})`),
    ),
    check(
      'payment_method_domains_google_pay_status_check',
      sql.raw(`google_pay_status in (${inList(PAYMENT_METHOD_DOMAIN_WALLET_STATUSES)})`),
    ),
    // A lowercase DNS name with at least one dot: no scheme, port, path or IP literal.
    check(
      'payment_method_domains_domain_name_check',
      sql.raw(
        `length(domain_name) <= 253 and domain_name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'`,
      ),
    ),
  ],
);
