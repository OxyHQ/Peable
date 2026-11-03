import { and, eq, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import type { OxyServiceEnvironment } from '@oxy.so/core/server';
import type { CurrencyCode, PaymentIntentRail } from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { paymentLinks } from '../schema';
import type { StoredContribution } from '../schema/payments';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';

/**
 * Reads and writes for `payment_links` — a shareable, reusable generator of
 * payment intents.
 *
 * NOT WIRED TO ANY ROUTE YET; see `db/merchants/merchantRepository.ts`'s header.
 */

export interface PaymentLinkRow {
  /**
   * The mode this row lives in — its merchant's, read in the same statement
   * (`merchantLivemodeOf`, ADR 0017). Selects the provider key any operation on
   * it is sent with, and is what the wire calls `livemode`.
   */
  readonly livemode: boolean;
  readonly id: string;
  readonly contribution?: StoredContribution | null;
  readonly contributionKey?: string | null;
  readonly publicId: string;
  readonly merchantId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly rail: PaymentIntentRail;
  /** FairCoin rail only — `null` on a card link (ADR 0001 D6). */
  readonly network: NetworkType | null;
  readonly active: boolean;
  readonly metadata: Record<string, string>;
  readonly successUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const LINK_COLUMNS = {
  livemode: merchantLivemodeOf(paymentLinks.merchantId),
  contribution: paymentLinks.contribution,
  contributionKey: paymentLinks.contributionKey,
  id: paymentLinks.id,
  publicId: paymentLinks.publicId,
  merchantId: paymentLinks.merchantId,
  oxyAppId: paymentLinks.oxyAppId,
  environment: paymentLinks.environment,
  amount: paymentLinks.amount,
  currency: paymentLinks.currency,
  rail: paymentLinks.rail,
  network: paymentLinks.network,
  active: paymentLinks.active,
  metadata: paymentLinks.metadata,
  successUrl: paymentLinks.successUrl,
  createdAt: paymentLinks.createdAt,
  updatedAt: paymentLinks.updatedAt,
} as const;

function toLinkRow(row: {
  environment: string;
  currency: string;
  rail: string;
  network: string | null;
  [key: string]: unknown;
}): PaymentLinkRow {
  return {
    ...row,
    environment: row.environment as OxyServiceEnvironment,
    currency: row.currency as CurrencyCode,
    rail: row.rail as PaymentIntentRail,
    network: row.network as NetworkType | null,
  } as unknown as PaymentLinkRow;
}

export interface InsertPaymentLinkParams {
  readonly contribution?: StoredContribution | null;
  readonly contributionKey?: string | null;
  readonly publicId: string;
  readonly merchantId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly rail: PaymentIntentRail;
  /** FairCoin rail only; `null` on a card link. */
  readonly network: NetworkType | null;
  readonly metadata: Record<string, string>;
  readonly successUrl?: string | undefined;
}

/**
 * Create a link.
 *
 * `oxy_app_id`, `environment` and `network` are supplied by the caller from the
 * merchant it already resolved — and cannot disagree with it, because
 * `payment_links_merchant_identity_fkey` references all four columns together.
 * A caller that passed a mismatched triple is refused by the database rather
 * than silently creating a link that claims the wrong application.
 *
 * On a CARD link `network` is null, which switches that four-column reference
 * off (`MATCH SIMPLE`); `payment_links_merchant_identity_no_network_fkey` is
 * what keeps the other three guaranteed. ADR 0001 D6.
 */
export async function insertPaymentLink(
  db: DatabaseOrTransaction,
  params: InsertPaymentLinkParams,
): Promise<PaymentLinkRow> {
  const [row] = await db
    .insert(paymentLinks)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      contribution: params.contribution ?? null,
      contributionKey: params.contributionKey ?? null,
      merchantId: params.merchantId,
      oxyAppId: params.oxyAppId,
      environment: params.environment,
      amount: params.amount,
      currency: params.currency,
      rail: params.rail,
      network: params.network,
      metadata: params.metadata,
      successUrl: params.successUrl ?? null,
    })
    .returning(LINK_COLUMNS);
  if (!row) throw new Error('payment link insert returned no row');
  return toLinkRow(row);
}

/**
 * The PUBLIC checkout-page read: `link_…` alone, no owner.
 *
 * A payer visiting `/l/:id` has no Oxy session at all, so there is nothing to
 * scope by. Kept as a separate function from {@link findLinkForMerchant} for
 * the same reason the payment-intent reads are split: the difference is who may
 * see the row, and a flag would let a merchant-authed handler pass the wrong
 * one and return another merchant's link.
 */
export async function findLinkByPublicId(
  db: DatabaseOrTransaction,
  publicId: string,
): Promise<PaymentLinkRow | null> {
  const [row] = await db
    .select(LINK_COLUMNS)
    .from(paymentLinks)
    .where(eq(paymentLinks.publicId, publicId));
  return row ? toLinkRow(row) : null;
}

/** The MERCHANT read: ownership in the WHERE clause, so a foreign link 404s exactly like a missing one. */
export async function findLinkForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<PaymentLinkRow | null> {
  const [row] = await db
    .select(LINK_COLUMNS)
    .from(paymentLinks)
    .where(and(eq(paymentLinks.publicId, publicId), eq(paymentLinks.merchantId, merchantId)));
  return row ? toLinkRow(row) : null;
}

export interface ListLinksParams {
  readonly merchantId: string;
  readonly active?: boolean | undefined;
  /**
   * Only the contribution links of this organization (`payment_links.contribution
   * ->> 'organizationId'`). Absent: every link, contribution or not.
   */
  readonly contributionOrganizationId?: string | undefined;
  readonly page: KeysetPage;
}

/** One page, newest first. Same ordering contract as `listIntentsForMerchant` — read its note. */
export async function listLinksForMerchant(
  db: DatabaseOrTransaction,
  params: ListLinksParams,
): Promise<{ data: PaymentLinkRow[]; hasMore: boolean }> {
  const walk = keyset(paymentLinks.id, paymentLinks.createdAt, params.page);
  const rows = await db
    .select(LINK_COLUMNS)
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.merchantId, params.merchantId),
        params.active === undefined ? undefined : eq(paymentLinks.active, params.active),
        params.contributionOrganizationId === undefined
          ? undefined
          : sql`${paymentLinks.contribution}->>'organizationId' = ${params.contributionOrganizationId}`,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toLinkRow));
}

export interface PaymentLinkPatch {
  readonly active?: boolean | undefined;
  /** A patch, merged in the statement — see `db/metadata.ts`. */
  readonly metadata?: MetadataPatch | undefined;
  readonly successUrl?: string | null | undefined;
}

/**
 * Apply the mutable link fields, and only those.
 *
 * `amount` and `network` are absent from the parameter type rather than
 * filtered out of it: a link's price is immutable once shared, because a payer
 * who was quoted one amount must not be charged another when they follow the
 * same URL. There is no way to express that change through this function, which
 * is stronger than validating against it.
 *
 * Scoped to the merchant in the same statement, so a patch cannot reach a link
 * the caller does not own. `limit_exceeded` is a metadata patch whose MERGED
 * bag would pass 50 keys — a different answer from a missing link (400, not 404).
 */
export async function updatePaymentLink(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
  patch: PaymentLinkPatch,
): Promise<PaymentLinkRow | 'missing' | 'limit_exceeded'> {
  const values: Record<string, unknown> = {};
  if (patch.active !== undefined) values.active = patch.active;
  if (patch.successUrl !== undefined) values.successUrl = patch.successUrl;
  const merged =
    patch.metadata === undefined
      ? undefined
      : mergedMetadata(paymentLinks.metadata, patch.metadata);
  if (merged !== undefined) values.metadata = merged;
  if (Object.keys(values).length === 0) {
    return (await findLinkForMerchant(db, publicId, merchantId)) ?? 'missing';
  }

  const scope = and(eq(paymentLinks.publicId, publicId), eq(paymentLinks.merchantId, merchantId));
  const [row] = await db
    .update(paymentLinks)
    .set(values)
    .where(merged === undefined ? scope : and(scope, metadataWithinLimit(merged)))
    .returning(LINK_COLUMNS);
  if (row) return toLinkRow(row);
  if (merged === undefined) return 'missing';
  return (await findLinkForMerchant(db, publicId, merchantId)) ? 'limit_exceeded' : 'missing';
}
