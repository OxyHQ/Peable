/**
 * Reads and writes for `payment_method_configurations` (`pmc_…`), their
 * provider bindings, and `payment_method_domains` (`pmd_…`).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { PaymentMethodConfigurationType } from '@peable.to/shared-types';
import { newId } from '../../lib/ids';
import {
  paymentMethodConfigurationBindings,
  paymentMethodConfigurations,
  paymentMethodDomains,
} from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import type { DatabaseOrTransaction } from '../postgres';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { PaymentMethodDomainWalletStatus } from '../schema/valueSets';

/**
 * The methods a merchant chooses: every configuration type but `faircoin`,
 * which is locked on (ADR 0021 D2) and so never has a stored preference.
 */
export type ChoosablePaymentMethodType = Exclude<PaymentMethodConfigurationType, 'faircoin'>;

export type PaymentMethodPreferences = Partial<Record<ChoosablePaymentMethodType, 'on' | 'off'>>;

export interface PaymentMethodConfigurationRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly name: string;
  readonly active: boolean;
  readonly isDefault: boolean;
  readonly preferences: PaymentMethodPreferences;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const CONFIGURATION_COLUMNS = {
  id: paymentMethodConfigurations.id,
  publicId: paymentMethodConfigurations.publicId,
  merchantId: paymentMethodConfigurations.merchantId,
  livemode: merchantLivemodeOf(paymentMethodConfigurations.merchantId),
  name: paymentMethodConfigurations.name,
  active: paymentMethodConfigurations.active,
  isDefault: paymentMethodConfigurations.isDefault,
  preferences: paymentMethodConfigurations.preferences,
  version: paymentMethodConfigurations.version,
  createdAt: paymentMethodConfigurations.createdAt,
  updatedAt: paymentMethodConfigurations.updatedAt,
} as const;

/** The name of the configuration every merchant has. */
export const DEFAULT_CONFIGURATION_NAME = 'Default';

/**
 * The merchant's default configuration, created on first need.
 *
 * ONE statement converges two racing creators: the partial unique index on
 * `merchant_id where is_default` refuses the second insert, `do nothing`
 * swallows it, and the read below finds the winner.
 */
export async function ensureDefaultConfiguration(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<PaymentMethodConfigurationRow> {
  await db
    .insert(paymentMethodConfigurations)
    .values({
      publicId: newId('pmc'),
      merchantId,
      name: DEFAULT_CONFIGURATION_NAME,
      isDefault: true,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select(CONFIGURATION_COLUMNS)
    .from(paymentMethodConfigurations)
    .where(
      and(
        eq(paymentMethodConfigurations.merchantId, merchantId),
        eq(paymentMethodConfigurations.isDefault, true),
      ),
    )
    .limit(1);
  if (!row)
    throw new Error(`merchant ${merchantId} has no default configuration after creating one`);
  return row as PaymentMethodConfigurationRow;
}

export async function insertConfiguration(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly name: string;
    readonly preferences: PaymentMethodPreferences;
  },
): Promise<PaymentMethodConfigurationRow> {
  const [row] = await db
    .insert(paymentMethodConfigurations)
    .values({
      publicId: newId('pmc'),
      merchantId: params.merchantId,
      name: params.name,
      preferences: params.preferences,
    })
    .returning(CONFIGURATION_COLUMNS);
  if (!row) throw new Error('payment method configuration could not be read back after insert');
  return row as PaymentMethodConfigurationRow;
}

/** By `pmc_…`, SCOPED TO THE MERCHANT. */
export async function findConfigurationByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<PaymentMethodConfigurationRow | null> {
  const [row] = await db
    .select(CONFIGURATION_COLUMNS)
    .from(paymentMethodConfigurations)
    .where(
      and(
        eq(paymentMethodConfigurations.merchantId, merchantId),
        eq(paymentMethodConfigurations.publicId, publicId),
      ),
    )
    .limit(1);
  return (row as PaymentMethodConfigurationRow | undefined) ?? null;
}

export async function findConfigurationById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<PaymentMethodConfigurationRow | null> {
  const [row] = await db
    .select(CONFIGURATION_COLUMNS)
    .from(paymentMethodConfigurations)
    .where(eq(paymentMethodConfigurations.id, id))
    .limit(1);
  return (row as PaymentMethodConfigurationRow | undefined) ?? null;
}

export async function listConfigurationsForMerchant(
  db: DatabaseOrTransaction,
  params: { readonly merchantId: string; readonly page: KeysetPage },
): Promise<{ data: PaymentMethodConfigurationRow[]; hasMore: boolean }> {
  const walk = keyset(
    paymentMethodConfigurations.id,
    paymentMethodConfigurations.createdAt,
    params.page,
  );
  const rows = await db
    .select(CONFIGURATION_COLUMNS)
    .from(paymentMethodConfigurations)
    .where(and(eq(paymentMethodConfigurations.merchantId, params.merchantId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows as PaymentMethodConfigurationRow[]);
}

/**
 * Apply a change in ONE statement: the preferences are MERGED (`||`), so two
 * concurrent toggles of different methods both land, and `version` moves so the
 * provider binding is pushed again before the next payment uses it.
 */
export async function updateConfiguration(
  db: DatabaseOrTransaction,
  id: string,
  patch: {
    readonly name?: string | undefined;
    readonly active?: boolean | undefined;
    readonly preferences?: PaymentMethodPreferences | undefined;
  },
): Promise<PaymentMethodConfigurationRow | null> {
  const [row] = await db
    .update(paymentMethodConfigurations)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.preferences !== undefined
        ? {
            preferences: sql`${paymentMethodConfigurations.preferences} || ${JSON.stringify(patch.preferences)}::jsonb`,
          }
        : {}),
      version: sql`${paymentMethodConfigurations.version} + 1`,
    })
    .where(eq(paymentMethodConfigurations.id, id))
    .returning(CONFIGURATION_COLUMNS);
  return (row as PaymentMethodConfigurationRow | undefined) ?? null;
}

/**
 * "Unset" preferences back to Orbit's default (`preference: 'none'`). Moves no
 * version: it is called in the same transaction as `updateConfiguration`, which
 * does, so one change is one version.
 */
export async function clearConfigurationPreferences(
  db: DatabaseOrTransaction,
  id: string,
  types: readonly ChoosablePaymentMethodType[],
): Promise<void> {
  if (types.length === 0) return;
  await db
    .update(paymentMethodConfigurations)
    .set({
      preferences: sql`${paymentMethodConfigurations.preferences} - ARRAY[${sql.join(
        types.map((type) => sql`${type}`),
        sql`, `,
      )}]::text[]`,
    })
    .where(eq(paymentMethodConfigurations.id, id));
}

export interface ConfigurationBindingRow {
  readonly providerObjectId: string;
  readonly syncedVersion: number;
}

export async function findConfigurationBinding(
  db: DatabaseOrTransaction,
  configurationId: string,
  provider: string,
): Promise<ConfigurationBindingRow | null> {
  const [row] = await db
    .select({
      providerObjectId: paymentMethodConfigurationBindings.providerObjectId,
      syncedVersion: paymentMethodConfigurationBindings.syncedVersion,
    })
    .from(paymentMethodConfigurationBindings)
    .where(
      and(
        eq(paymentMethodConfigurationBindings.configurationId, configurationId),
        eq(paymentMethodConfigurationBindings.provider, provider),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Record what the provider accepted. `synced_version` only moves FORWARD: a slow
 * push of an older version finishing after a newer one cannot mark the binding
 * as holding the older state.
 */
export async function upsertConfigurationBinding(
  db: DatabaseOrTransaction,
  params: {
    readonly configurationId: string;
    readonly provider: string;
    readonly providerObjectId: string;
    readonly syncedVersion: number;
  },
): Promise<void> {
  const t = paymentMethodConfigurationBindings;
  await db
    .insert(t)
    .values(params)
    .onConflictDoUpdate({
      target: [t.configurationId, t.provider],
      set: {
        syncedVersion: sql`greatest(${t.syncedVersion}, excluded.synced_version)`,
      },
    });
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export interface PaymentMethodDomainRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly domainName: string;
  readonly enabled: boolean;
  readonly applePayStatus: PaymentMethodDomainWalletStatus;
  readonly applePayError: string | null;
  readonly googlePayStatus: PaymentMethodDomainWalletStatus;
  readonly googlePayError: string | null;
  readonly provider: string;
  readonly providerObjectId: string;
  readonly createdAt: Date;
}

const DOMAIN_COLUMNS = {
  id: paymentMethodDomains.id,
  publicId: paymentMethodDomains.publicId,
  merchantId: paymentMethodDomains.merchantId,
  livemode: merchantLivemodeOf(paymentMethodDomains.merchantId),
  domainName: paymentMethodDomains.domainName,
  enabled: paymentMethodDomains.enabled,
  applePayStatus: paymentMethodDomains.applePayStatus,
  applePayError: paymentMethodDomains.applePayError,
  googlePayStatus: paymentMethodDomains.googlePayStatus,
  googlePayError: paymentMethodDomains.googlePayError,
  provider: paymentMethodDomains.provider,
  providerObjectId: paymentMethodDomains.providerObjectId,
  createdAt: paymentMethodDomains.createdAt,
} as const;

/** The provider's standing of a domain, as the row stores it. */
export interface DomainStanding {
  readonly enabled: boolean;
  readonly applePayStatus: PaymentMethodDomainWalletStatus;
  readonly applePayError: string | null;
  readonly googlePayStatus: PaymentMethodDomainWalletStatus;
  readonly googlePayError: string | null;
}

/**
 * Record a domain the provider registered. `null` when the merchant already
 * holds it, or the provider object is another merchant's (the two unique keys).
 */
export async function insertDomain(
  db: DatabaseOrTransaction,
  params: DomainStanding & {
    readonly merchantId: string;
    readonly domainName: string;
    readonly provider: string;
    readonly providerObjectId: string;
  },
): Promise<PaymentMethodDomainRow | null> {
  const [row] = await db
    .insert(paymentMethodDomains)
    .values({ publicId: newId('pmd'), ...params })
    .onConflictDoNothing()
    .returning(DOMAIN_COLUMNS);
  return (row as PaymentMethodDomainRow | undefined) ?? null;
}

export async function findDomainByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<PaymentMethodDomainRow | null> {
  const [row] = await db
    .select(DOMAIN_COLUMNS)
    .from(paymentMethodDomains)
    .where(
      and(
        eq(paymentMethodDomains.merchantId, merchantId),
        eq(paymentMethodDomains.publicId, publicId),
      ),
    )
    .limit(1);
  return (row as PaymentMethodDomainRow | undefined) ?? null;
}

export async function findDomainByName(
  db: DatabaseOrTransaction,
  merchantId: string,
  domainName: string,
): Promise<PaymentMethodDomainRow | null> {
  const [row] = await db
    .select(DOMAIN_COLUMNS)
    .from(paymentMethodDomains)
    .where(
      and(
        eq(paymentMethodDomains.merchantId, merchantId),
        eq(paymentMethodDomains.domainName, domainName),
      ),
    )
    .limit(1);
  return (row as PaymentMethodDomainRow | undefined) ?? null;
}

export async function listDomainsForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly domainName?: string | undefined;
    readonly enabled?: boolean | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: PaymentMethodDomainRow[]; hasMore: boolean }> {
  const walk = keyset(paymentMethodDomains.id, paymentMethodDomains.createdAt, params.page);
  const rows = await db
    .select(DOMAIN_COLUMNS)
    .from(paymentMethodDomains)
    .where(
      and(
        eq(paymentMethodDomains.merchantId, params.merchantId),
        params.domainName === undefined
          ? undefined
          : eq(paymentMethodDomains.domainName, params.domainName),
        params.enabled === undefined ? undefined : eq(paymentMethodDomains.enabled, params.enabled),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows as PaymentMethodDomainRow[]);
}

/** Store the provider's latest word on a domain. */
export async function updateDomainStanding(
  db: DatabaseOrTransaction,
  id: string,
  standing: DomainStanding,
): Promise<PaymentMethodDomainRow | null> {
  const [row] = await db
    .update(paymentMethodDomains)
    .set({ ...standing })
    .where(eq(paymentMethodDomains.id, id))
    .returning(DOMAIN_COLUMNS);
  return (row as PaymentMethodDomainRow | undefined) ?? null;
}
