import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { BillingPortalConfiguration, BillingPortalFeatures } from '@peable.to/shared-types';
import { billingPortalConfigurations, billingPortalSessions } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import { nowMs, requiredPublicIdOf } from './columns';

/** Reads and writes for portal configurations and sessions (ADR 0018 §9). */

export interface PortalConfigurationRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly active: boolean;
  readonly isDefault: boolean;
  readonly businessProfile: BillingPortalConfiguration['business_profile'];
  readonly defaultReturnUrl: string | null;
  readonly features: BillingPortalFeatures;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const CONFIG_COLUMNS = {
  id: billingPortalConfigurations.id,
  publicId: billingPortalConfigurations.publicId,
  merchantId: billingPortalConfigurations.merchantId,
  livemode: merchantLivemodeOf(billingPortalConfigurations.merchantId),
  active: billingPortalConfigurations.active,
  isDefault: billingPortalConfigurations.isDefault,
  businessProfile: billingPortalConfigurations.businessProfile,
  defaultReturnUrl: billingPortalConfigurations.defaultReturnUrl,
  features: billingPortalConfigurations.features,
  metadata: billingPortalConfigurations.metadata,
  createdAt: billingPortalConfigurations.createdAt,
  updatedAt: billingPortalConfigurations.updatedAt,
} as const;

/** `null` when `isDefault` and the merchant already has a default. */
export async function insertPortalConfiguration(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly isDefault: boolean;
    readonly businessProfile: BillingPortalConfiguration['business_profile'];
    readonly defaultReturnUrl: string | null;
    readonly features: BillingPortalFeatures;
    readonly metadata: Record<string, string>;
  },
): Promise<PortalConfigurationRow | null> {
  const [row] = await db
    .insert(billingPortalConfigurations)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning(CONFIG_COLUMNS);
  return row ?? null;
}

export async function findPortalConfigurationForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<PortalConfigurationRow | null> {
  const [row] = await db
    .select(CONFIG_COLUMNS)
    .from(billingPortalConfigurations)
    .where(
      and(
        eq(billingPortalConfigurations.publicId, publicId),
        eq(billingPortalConfigurations.merchantId, merchantId),
      ),
    );
  return row ?? null;
}

export async function findPortalConfigurationById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<PortalConfigurationRow | null> {
  const [row] = await db
    .select(CONFIG_COLUMNS)
    .from(billingPortalConfigurations)
    .where(eq(billingPortalConfigurations.id, id));
  return row ?? null;
}

export async function findDefaultPortalConfiguration(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<PortalConfigurationRow | null> {
  const [row] = await db
    .select(CONFIG_COLUMNS)
    .from(billingPortalConfigurations)
    .where(
      and(
        eq(billingPortalConfigurations.merchantId, merchantId),
        eq(billingPortalConfigurations.isDefault, true),
      ),
    );
  return row ?? null;
}

export async function updatePortalConfiguration(
  tx: Transaction,
  id: string,
  patch: {
    readonly active?: boolean;
    readonly businessProfile?: BillingPortalConfiguration['business_profile'];
    readonly defaultReturnUrl?: string | null;
    readonly features?: BillingPortalFeatures;
    readonly metadata?: MetadataPatch;
  },
): Promise<PortalConfigurationRow | 'limit_exceeded'> {
  const { metadata, ...rest } = patch;
  const where = [eq(billingPortalConfigurations.id, id)];
  if (metadata) {
    where.push(metadataWithinLimit(mergedMetadata(billingPortalConfigurations.metadata, metadata)));
  }
  const [row] = await tx
    .update(billingPortalConfigurations)
    .set({
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      ...(metadata
        ? { metadata: mergedMetadata(billingPortalConfigurations.metadata, metadata) }
        : {}),
      updatedAt: nowMs,
    })
    .where(and(...where))
    .returning(CONFIG_COLUMNS);
  return row ?? 'limit_exceeded';
}

export async function listPortalConfigurations(
  db: DatabaseOrTransaction,
  filters: {
    readonly merchantId: string;
    readonly page: KeysetPage;
    readonly active?: boolean | undefined;
    readonly isDefault?: boolean | undefined;
  },
): Promise<{ data: PortalConfigurationRow[]; hasMore: boolean }> {
  const walk = keyset(
    billingPortalConfigurations.id,
    billingPortalConfigurations.createdAt,
    filters.page,
  );
  const rows = await db
    .select(CONFIG_COLUMNS)
    .from(billingPortalConfigurations)
    .where(
      and(
        eq(billingPortalConfigurations.merchantId, filters.merchantId),
        filters.active !== undefined
          ? eq(billingPortalConfigurations.active, filters.active)
          : undefined,
        filters.isDefault !== undefined
          ? eq(billingPortalConfigurations.isDefault, filters.isDefault)
          : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

export interface PortalSessionRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly customerId: string;
  readonly customerPublicId: string;
  readonly configurationId: string;
  readonly configurationPublicId: string;
  readonly returnUrl: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

const S = 'billing_portal_sessions';
const SESSION_COLUMNS = {
  id: billingPortalSessions.id,
  publicId: billingPortalSessions.publicId,
  merchantId: billingPortalSessions.merchantId,
  livemode: merchantLivemodeOf(billingPortalSessions.merchantId),
  customerId: billingPortalSessions.customerId,
  customerPublicId: requiredPublicIdOf('customers', S, 'customer_id'),
  configurationId: billingPortalSessions.configurationId,
  configurationPublicId: requiredPublicIdOf('billing_portal_configurations', S, 'configuration_id'),
  returnUrl: billingPortalSessions.returnUrl,
  expiresAt: billingPortalSessions.expiresAt,
  createdAt: billingPortalSessions.createdAt,
} as const;

export async function insertPortalSession(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly customerId: string;
    readonly configurationId: string;
    readonly tokenHash: string;
    readonly returnUrl: string | null;
    readonly expiresAt: Date;
  },
): Promise<PortalSessionRow> {
  const [row] = await db
    .insert(billingPortalSessions)
    .values({ id: uuidv7(), ...params })
    .returning(SESSION_COLUMNS);
  if (!row) throw new Error('portal session insert returned no row');
  return row;
}

/** A session by its token's hash, while it has not expired (judged by the database clock). */
export async function findLivePortalSession(
  db: DatabaseOrTransaction,
  tokenHash: string,
): Promise<PortalSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(billingPortalSessions)
    .where(
      and(
        eq(billingPortalSessions.tokenHash, tokenHash),
        sql`${billingPortalSessions.expiresAt} > now()`,
      ),
    );
  return row ?? null;
}
