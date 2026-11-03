import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import type { OxyServiceEnvironment } from '@oxy.so/core/server';
import type {
  CheckoutCustomerCreation,
  CheckoutLocale,
  CheckoutSubmitType,
  CurrencyCode,
  PaymentIntentRail,
} from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { paymentLinkLineItems, paymentLinks } from '../schema';
import type {
  StoredCheckoutCollection,
  StoredContribution,
  StoredCustomField,
} from '../schema/payments';
import type { AfterCompletionType } from '../schema/valueSets';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';

/**
 * Reads and writes for `payment_links` and their line items (Orbit Phase 3).
 *
 * A link's line items are written once, with the link, and never changed: a
 * payer may already hold a session priced from them. Everything else on a
 * link is an option the next session copies.
 */

export interface PaymentLinkRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  readonly contribution: StoredContribution | null;
  readonly contributionKey: string | null;
  /** Contribution links only (`payment_links_amount_shape_check`). */
  readonly amount: string | null;
  readonly currency: CurrencyCode;
  readonly rail: PaymentIntentRail;
  readonly network: NetworkType | null;
  readonly active: boolean;
  readonly metadata: Record<string, string>;
  readonly allowPromotionCodes: boolean;
  readonly collection: StoredCheckoutCollection | null;
  readonly customFields: StoredCustomField[];
  readonly automaticTax: boolean;
  readonly customerCreation: CheckoutCustomerCreation;
  readonly submitType: CheckoutSubmitType;
  readonly locale: CheckoutLocale | null;
  readonly afterCompletionType: AfterCompletionType;
  readonly afterCompletionUrl: string | null;
  readonly afterCompletionMessage: string | null;
  readonly completedSessionsLimit: number | null;
  readonly completedSessionsCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const LINK_COLUMNS = {
  livemode: merchantLivemodeOf(paymentLinks.merchantId),
  id: paymentLinks.id,
  publicId: paymentLinks.publicId,
  merchantId: paymentLinks.merchantId,
  oxyAppId: paymentLinks.oxyAppId,
  environment: paymentLinks.environment,
  contribution: paymentLinks.contribution,
  contributionKey: paymentLinks.contributionKey,
  amount: paymentLinks.amount,
  currency: paymentLinks.currency,
  rail: paymentLinks.rail,
  network: paymentLinks.network,
  active: paymentLinks.active,
  metadata: paymentLinks.metadata,
  allowPromotionCodes: paymentLinks.allowPromotionCodes,
  collection: paymentLinks.collection,
  customFields: paymentLinks.customFields,
  automaticTax: paymentLinks.automaticTax,
  customerCreation: paymentLinks.customerCreation,
  submitType: paymentLinks.submitType,
  locale: paymentLinks.locale,
  afterCompletionType: paymentLinks.afterCompletionType,
  afterCompletionUrl: paymentLinks.afterCompletionUrl,
  afterCompletionMessage: paymentLinks.afterCompletionMessage,
  completedSessionsLimit: paymentLinks.completedSessionsLimit,
  completedSessionsCount: paymentLinks.completedSessionsCount,
  createdAt: paymentLinks.createdAt,
  updatedAt: paymentLinks.updatedAt,
} as const;

/** The text columns are CHECK-constrained to these sets; the cast only restates it. */
function toLinkRow(row: Record<string, unknown>): PaymentLinkRow {
  return row as unknown as PaymentLinkRow;
}

export interface PaymentLinkLineItemRow {
  readonly id: string;
  readonly linkId: string;
  readonly position: number;
  /** INTERNAL price id. */
  readonly priceId: string;
  readonly quantity: number;
  readonly adjustableEnabled: boolean;
  readonly adjustableMinimum: number | null;
  readonly adjustableMaximum: number | null;
}

const LINE_COLUMNS = {
  id: paymentLinkLineItems.id,
  linkId: paymentLinkLineItems.linkId,
  position: paymentLinkLineItems.position,
  priceId: paymentLinkLineItems.priceId,
  quantity: paymentLinkLineItems.quantity,
  adjustableEnabled: paymentLinkLineItems.adjustableEnabled,
  adjustableMinimum: paymentLinkLineItems.adjustableMinimum,
  adjustableMaximum: paymentLinkLineItems.adjustableMaximum,
} as const;

/** The options a link carries for the sessions it creates. */
export interface PaymentLinkOptions {
  readonly allowPromotionCodes: boolean;
  readonly collection: StoredCheckoutCollection | null;
  readonly customFields: readonly StoredCustomField[];
  readonly automaticTax: boolean;
  readonly customerCreation: CheckoutCustomerCreation;
  readonly submitType: CheckoutSubmitType;
  readonly locale: CheckoutLocale | null;
  readonly afterCompletionType: AfterCompletionType;
  readonly afterCompletionUrl: string | null;
  readonly afterCompletionMessage: string | null;
  readonly completedSessionsLimit: number | null;
}

export const DEFAULT_LINK_OPTIONS: PaymentLinkOptions = {
  allowPromotionCodes: false,
  collection: null,
  customFields: [],
  automaticTax: false,
  customerCreation: 'if_required',
  submitType: 'auto',
  locale: null,
  afterCompletionType: 'hosted_confirmation',
  afterCompletionUrl: null,
  afterCompletionMessage: null,
  completedSessionsLimit: null,
};

export interface InsertPaymentLinkParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  readonly currency: CurrencyCode;
  readonly rail: PaymentIntentRail;
  /** FairCoin rail only; `null` on a card link. */
  readonly network: NetworkType | null;
  readonly metadata: Record<string, string>;
  readonly options?: PaymentLinkOptions;
  /** A price link's lines (INTERNAL price ids, already the merchant's). */
  readonly lineItems?: readonly {
    readonly priceId: string;
    readonly quantity: number;
    readonly adjustable: { readonly minimum: number; readonly maximum: number } | null;
  }[];
  /** A contribution link's amount and details — and then no line items. */
  readonly amount?: string | null;
  readonly contribution?: StoredContribution | null;
  readonly contributionKey?: string | null;
}

/**
 * Create a link and its line items, in the caller's transaction.
 *
 * `oxy_app_id`, `environment` and `network` come from the merchant the caller
 * resolved and cannot disagree with it: `payment_links_merchant_identity_fkey`
 * references all four together (ADR 0001 D6 for the card half).
 */
export async function insertPaymentLink(
  tx: DatabaseOrTransaction,
  params: InsertPaymentLinkParams,
): Promise<PaymentLinkRow> {
  const options = params.options ?? DEFAULT_LINK_OPTIONS;
  const [row] = await tx
    .insert(paymentLinks)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      oxyAppId: params.oxyAppId,
      environment: params.environment,
      contribution: params.contribution ?? null,
      contributionKey: params.contributionKey ?? null,
      amount: params.amount ?? null,
      currency: params.currency,
      rail: params.rail,
      network: params.network,
      metadata: params.metadata,
      allowPromotionCodes: options.allowPromotionCodes,
      collection: options.collection,
      customFields: [...options.customFields],
      automaticTax: options.automaticTax,
      customerCreation: options.customerCreation,
      submitType: options.submitType,
      locale: options.locale,
      afterCompletionType: options.afterCompletionType,
      afterCompletionUrl: options.afterCompletionUrl,
      afterCompletionMessage: options.afterCompletionMessage,
      completedSessionsLimit: options.completedSessionsLimit,
    })
    .returning(LINK_COLUMNS);
  if (!row) throw new Error('payment link insert returned no row');
  const link = toLinkRow(row);
  const lines = params.lineItems ?? [];
  if (lines.length > 0) {
    await tx.insert(paymentLinkLineItems).values(
      lines.map((line, position) => ({
        id: uuidv7(),
        linkId: link.id,
        merchantId: link.merchantId,
        position,
        priceId: line.priceId,
        quantity: line.quantity,
        adjustableEnabled: line.adjustable !== null,
        adjustableMinimum: line.adjustable?.minimum ?? null,
        adjustableMaximum: line.adjustable?.maximum ?? null,
      })),
    );
  }
  return link;
}

/** The PAYER read: `link_…` alone — an anonymous visitor has nothing to scope by. */
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

/** The MERCHANT read: ownership in the WHERE clause, so a foreign link 404s like a missing one. */
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

export async function findLinkById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<PaymentLinkRow | null> {
  const [row] = await db.select(LINK_COLUMNS).from(paymentLinks).where(eq(paymentLinks.id, id));
  return row ? toLinkRow(row) : null;
}

export interface ListLinksParams {
  readonly merchantId: string;
  readonly active?: boolean | undefined;
  /** Only this organization's contribution links. Absent: every link. */
  readonly contributionOrganizationId?: string | undefined;
  readonly page: KeysetPage;
}

/** One page, newest first (`db/keyset.ts`). */
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

/** A link's lines, in order. */
export async function listLinkLineItems(
  db: DatabaseOrTransaction,
  linkId: string,
): Promise<PaymentLinkLineItemRow[]> {
  return db
    .select(LINE_COLUMNS)
    .from(paymentLinkLineItems)
    .where(eq(paymentLinkLineItems.linkId, linkId))
    .orderBy(asc(paymentLinkLineItems.position));
}

/** The lines of several links (one query for a page). */
export async function listLineItemsForLinks(
  db: DatabaseOrTransaction,
  linkIds: readonly string[],
): Promise<Map<string, PaymentLinkLineItemRow[]>> {
  const map = new Map<string, PaymentLinkLineItemRow[]>();
  if (linkIds.length === 0) return map;
  const rows = await db
    .select(LINE_COLUMNS)
    .from(paymentLinkLineItems)
    .where(inArray(paymentLinkLineItems.linkId, [...linkIds]))
    .orderBy(asc(paymentLinkLineItems.position));
  for (const row of rows) {
    const list = map.get(row.linkId) ?? [];
    list.push(row);
    map.set(row.linkId, list);
  }
  return map;
}

export interface PaymentLinkPatch {
  readonly active?: boolean | undefined;
  readonly metadata?: MetadataPatch | undefined;
  readonly options?: Partial<PaymentLinkOptions> | undefined;
}

/**
 * Apply the mutable link fields — never the line items, which are not in the
 * parameter type at all. Scoped to the merchant in the statement.
 * `limit_exceeded` is a metadata patch whose MERGED bag would pass 50 keys.
 */
export async function updatePaymentLink(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
  patch: PaymentLinkPatch,
): Promise<PaymentLinkRow | 'missing' | 'limit_exceeded'> {
  const values: Record<string, unknown> = { ...(patch.options ?? {}) };
  if ('customFields' in values && values.customFields !== undefined) {
    values.customFields = [...(values.customFields as StoredCustomField[])];
  }
  if (patch.active !== undefined) values.active = patch.active;
  const merged =
    patch.metadata === undefined
      ? undefined
      : mergedMetadata(paymentLinks.metadata, patch.metadata);
  if (merged !== undefined) values.metadata = merged;
  for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  if (Object.keys(values).length === 0) {
    return (await findLinkForMerchant(db, publicId, merchantId)) ?? 'missing';
  }
  values.updatedAt = sql`date_trunc('milliseconds', now())`;
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

/**
 * One more session of this link completed — in the completion's transaction.
 * The count and the deactivation at `restrictions.completed_sessions.limit`
 * are ONE statement, so two completions racing to the limit both count and
 * the link is deactivated once.
 */
export async function countLinkCompletion(
  tx: DatabaseOrTransaction,
  linkId: string,
): Promise<{ row: PaymentLinkRow; deactivated: boolean } | null> {
  const [before] = await tx
    .select({ active: paymentLinks.active })
    .from(paymentLinks)
    .where(eq(paymentLinks.id, linkId))
    .for('update');
  if (!before) return null;
  const [row] = await tx
    .update(paymentLinks)
    .set({
      completedSessionsCount: sql`${paymentLinks.completedSessionsCount} + 1`,
      active: sql`case when ${paymentLinks.completedSessionsLimit} is not null and ${paymentLinks.completedSessionsCount} + 1 >= ${paymentLinks.completedSessionsLimit} then false else ${paymentLinks.active} end`,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(eq(paymentLinks.id, linkId))
    .returning(LINK_COLUMNS);
  if (!row) return null;
  const link = toLinkRow(row);
  return { row: link, deactivated: before.active && !link.active };
}
