import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import type { OxyServiceEnvironment } from '@oxy.so/core/server';
import type {
  CheckoutConsent,
  CheckoutCustomerCreation,
  CheckoutCustomerDetails,
  CheckoutLocale,
  CheckoutSessionMode,
  CheckoutSessionPaymentStatus,
  CheckoutSessionStatus,
  CheckoutShippingDetails,
  CheckoutSubmitType,
  CheckoutUiMode,
  CurrencyCode,
  PaymentIntentRail,
} from '@peable.to/shared-types';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { checkoutSessionLineItems, checkoutSessions, paymentIntents } from '../schema';
import type { StoredLinePrice } from '../schema/checkout';
import type { StoredCheckoutCollection, StoredCustomField } from '../schema/payments';
import type { AutomaticTaxStatus } from '../schema/valueSets';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { clientSecretFor, newId } from '../../lib/ids';

/**
 * Reads and writes for `checkout_sessions` and their line items (Orbit
 * Phase 3) — the order a payer completes.
 *
 * Every state move is a compare-and-swap on `status` (and, while the payer
 * edits the order, on there being no payment yet), the rule
 * `updateIntentState` follows for payments: a writer that read the session
 * and decided must find it where it read it, or write nothing.
 */

export interface CheckoutSessionRow {
  /** ADR 0017 — the merchant's mode, read in the same statement. */
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  /** The merchant's PUBLIC `merch_…`. */
  readonly merchantPublicId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  readonly mode: CheckoutSessionMode;
  readonly status: CheckoutSessionStatus;
  readonly paymentStatus: CheckoutSessionPaymentStatus;
  readonly uiMode: CheckoutUiMode;
  readonly locale: CheckoutLocale | null;
  readonly submitType: CheckoutSubmitType;
  readonly clientSecret: string | null;
  /** INTERNAL id of the payment, once confirmed. */
  readonly paymentIntentId: string | null;
  /** Its public `pi_…`. */
  readonly paymentIntentPublicId: string | null;
  readonly setupIntentId: string | null;
  readonly setupIntentPublicId: string | null;
  /** `amount_total` (the column is `amount`, see the table). */
  readonly amount: string;
  readonly amountSubtotal: string;
  readonly amountDiscount: string;
  readonly amountTax: string;
  readonly amountShipping: string;
  readonly currency: CurrencyCode;
  readonly rail: PaymentIntentRail;
  readonly network: NetworkType | null;
  readonly connectedAccountId: string | null;
  readonly connectedAccountPublicId: string | null;
  readonly customerId: string | null;
  readonly customerPublicId: string | null;
  readonly customerEmail: string | null;
  readonly customerCreation: CheckoutCustomerCreation;
  readonly customerDetails: CheckoutCustomerDetails | null;
  readonly shippingDetails: CheckoutShippingDetails | null;
  readonly collection: StoredCheckoutCollection | null;
  readonly customFields: StoredCustomField[];
  readonly consent: CheckoutConsent | null;
  readonly allowPromotionCodes: boolean;
  readonly couponId: string | null;
  readonly couponPublicId: string | null;
  readonly promotionCodeId: string | null;
  readonly promotionCodePublicId: string | null;
  readonly automaticTax: boolean;
  readonly automaticTaxStatus: AutomaticTaxStatus | null;
  readonly taxCalculationId: string | null;
  readonly clientReferenceId: string | null;
  readonly paymentLinkId: string | null;
  readonly paymentLinkPublicId: string | null;
  readonly confirmationMessage: string | null;
  readonly linkOperationKey: string | null;
  readonly metadata: Record<string, string>;
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  readonly expiresAt: Date | null;
  readonly completedAt: Date | null;
  readonly expiredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Raw, aliased and table-qualified: RETURNING renders column refs unqualified (CONVENTIONS.md). */
const publicIdOf = (table: string, column: string) =>
  sql<string | null>`(${sql.raw(
    `select x.public_id from ${table} x where x.id = "checkout_sessions"."${column}"`,
  )})`;

const SESSION_COLUMNS = {
  livemode: merchantLivemodeOf(checkoutSessions.merchantId),
  id: checkoutSessions.id,
  publicId: checkoutSessions.publicId,
  merchantId: checkoutSessions.merchantId,
  merchantPublicId: sql<string>`(${sql.raw(
    'select m.public_id from merchants m where m.id = "checkout_sessions"."merchant_id"',
  )})`,
  oxyAppId: checkoutSessions.oxyAppId,
  environment: checkoutSessions.environment,
  mode: checkoutSessions.mode,
  status: checkoutSessions.status,
  paymentStatus: checkoutSessions.paymentStatus,
  uiMode: checkoutSessions.uiMode,
  locale: checkoutSessions.locale,
  submitType: checkoutSessions.submitType,
  clientSecret: checkoutSessions.clientSecret,
  paymentIntentId: checkoutSessions.paymentIntentId,
  paymentIntentPublicId: publicIdOf('payment_intents', 'payment_intent_id'),
  setupIntentId: checkoutSessions.setupIntentId,
  setupIntentPublicId: publicIdOf('setup_intents', 'setup_intent_id'),
  amount: checkoutSessions.amount,
  amountSubtotal: checkoutSessions.amountSubtotal,
  amountDiscount: checkoutSessions.amountDiscount,
  amountTax: checkoutSessions.amountTax,
  amountShipping: checkoutSessions.amountShipping,
  currency: checkoutSessions.currency,
  rail: checkoutSessions.rail,
  network: checkoutSessions.network,
  connectedAccountId: checkoutSessions.connectedAccountId,
  connectedAccountPublicId: publicIdOf('connected_accounts', 'connected_account_id'),
  customerId: checkoutSessions.customerId,
  customerPublicId: publicIdOf('customers', 'customer_id'),
  customerEmail: checkoutSessions.customerEmail,
  customerCreation: checkoutSessions.customerCreation,
  customerDetails: checkoutSessions.customerDetails,
  shippingDetails: checkoutSessions.shippingDetails,
  collection: checkoutSessions.collection,
  customFields: checkoutSessions.customFields,
  consent: checkoutSessions.consent,
  allowPromotionCodes: checkoutSessions.allowPromotionCodes,
  couponId: checkoutSessions.couponId,
  couponPublicId: publicIdOf('coupons', 'coupon_id'),
  promotionCodeId: checkoutSessions.promotionCodeId,
  promotionCodePublicId: publicIdOf('promotion_codes', 'promotion_code_id'),
  automaticTax: checkoutSessions.automaticTax,
  automaticTaxStatus: checkoutSessions.automaticTaxStatus,
  taxCalculationId: checkoutSessions.taxCalculationId,
  clientReferenceId: checkoutSessions.clientReferenceId,
  paymentLinkId: checkoutSessions.paymentLinkId,
  paymentLinkPublicId: publicIdOf('payment_links', 'payment_link_id'),
  confirmationMessage: checkoutSessions.confirmationMessage,
  linkOperationKey: checkoutSessions.linkOperationKey,
  metadata: checkoutSessions.metadata,
  successUrl: checkoutSessions.successUrl,
  cancelUrl: checkoutSessions.cancelUrl,
  expiresAt: checkoutSessions.expiresAt,
  completedAt: checkoutSessions.completedAt,
  expiredAt: checkoutSessions.expiredAt,
  createdAt: checkoutSessions.createdAt,
  updatedAt: checkoutSessions.updatedAt,
} as const;

/** The text columns are CHECK-constrained to these sets; the cast only restates it. */
function toSessionRow(row: Record<string, unknown>): CheckoutSessionRow {
  return row as unknown as CheckoutSessionRow;
}

const now = sql`date_trunc('milliseconds', now())`;

// ---- Line items -----------------------------------------------------------------

export interface CheckoutLineItemRow {
  readonly id: string;
  readonly publicId: string;
  readonly sessionId: string;
  readonly position: number;
  readonly priceId: string | null;
  readonly pricePublicId: string | null;
  readonly productId: string | null;
  readonly productPublicId: string | null;
  readonly description: string;
  readonly images: string[];
  readonly taxCode: string | null;
  readonly taxBehavior: 'inclusive' | 'exclusive' | 'unspecified';
  readonly currency: CurrencyCode;
  readonly price: StoredLinePrice;
  readonly quantity: number;
  readonly adjustableEnabled: boolean;
  readonly adjustableMinimum: number | null;
  readonly adjustableMaximum: number | null;
  readonly amountSubtotal: string;
  readonly amountDiscount: string;
  readonly amountTax: string;
  readonly amountTotal: string;
  readonly createdAt: Date;
}

const LINE_COLUMNS = {
  id: checkoutSessionLineItems.id,
  publicId: checkoutSessionLineItems.publicId,
  sessionId: checkoutSessionLineItems.sessionId,
  position: checkoutSessionLineItems.position,
  priceId: checkoutSessionLineItems.priceId,
  pricePublicId: sql<string | null>`(${sql.raw(
    'select p.public_id from prices p where p.id = "checkout_session_line_items"."price_id"',
  )})`,
  productId: checkoutSessionLineItems.productId,
  productPublicId: sql<string | null>`(${sql.raw(
    'select p.public_id from products p where p.id = "checkout_session_line_items"."product_id"',
  )})`,
  description: checkoutSessionLineItems.description,
  images: checkoutSessionLineItems.images,
  taxCode: checkoutSessionLineItems.taxCode,
  taxBehavior: checkoutSessionLineItems.taxBehavior,
  currency: checkoutSessionLineItems.currency,
  price: checkoutSessionLineItems.price,
  quantity: checkoutSessionLineItems.quantity,
  adjustableEnabled: checkoutSessionLineItems.adjustableEnabled,
  adjustableMinimum: checkoutSessionLineItems.adjustableMinimum,
  adjustableMaximum: checkoutSessionLineItems.adjustableMaximum,
  amountSubtotal: checkoutSessionLineItems.amountSubtotal,
  amountDiscount: checkoutSessionLineItems.amountDiscount,
  amountTax: checkoutSessionLineItems.amountTax,
  amountTotal: checkoutSessionLineItems.amountTotal,
  createdAt: checkoutSessionLineItems.createdAt,
} as const;

function toLineRow(row: Record<string, unknown>): CheckoutLineItemRow {
  return row as unknown as CheckoutLineItemRow;
}

/** A line as priced, ready to store. */
export interface NewLineItem {
  readonly priceId: string | null;
  readonly productId: string | null;
  readonly description: string;
  readonly images: readonly string[];
  readonly taxCode: string | null;
  readonly taxBehavior: 'inclusive' | 'exclusive' | 'unspecified';
  readonly currency: CurrencyCode;
  readonly price: StoredLinePrice;
  readonly quantity: number;
  readonly adjustable: { readonly minimum: number; readonly maximum: number } | null;
  readonly amountSubtotal: string;
  readonly amountDiscount: string;
  readonly amountTax: string;
  readonly amountTotal: string;
}

// ---- Insert ----------------------------------------------------------------------

/** The totals the pricer computed for an order. */
export interface SessionTotals {
  readonly amountSubtotal: string;
  readonly amountDiscount: string;
  readonly amountTax: string;
  readonly amountShipping: string;
  readonly amountTotal: string;
}

export interface InsertCheckoutSessionParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly oxyAppId: string;
  readonly environment: OxyServiceEnvironment;
  /**
   * A session around a payment that already exists — the FairCoin billing
   * invoice's. Every other session gets its payment when the payer confirms.
   */
  readonly paymentIntentId?: string | null;
  /** `amount_total`; with no `totals`, also the subtotal. */
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly rail: PaymentIntentRail;
  readonly network: NetworkType | null;
  readonly connectedAccountId?: string | null;
  readonly metadata: Record<string, string>;
  readonly successUrl?: string | undefined;
  readonly cancelUrl?: string | undefined;
  readonly mode?: CheckoutSessionMode;
  readonly uiMode?: CheckoutUiMode;
  readonly locale?: CheckoutLocale | null;
  readonly submitType?: CheckoutSubmitType;
  readonly totals?: SessionTotals;
  readonly customerId?: string | null;
  readonly customerEmail?: string | null;
  readonly customerCreation?: CheckoutCustomerCreation;
  readonly collection?: StoredCheckoutCollection | null;
  readonly customFields?: readonly StoredCustomField[];
  readonly allowPromotionCodes?: boolean;
  readonly couponId?: string | null;
  readonly promotionCodeId?: string | null;
  readonly automaticTax?: boolean;
  readonly automaticTaxStatus?: AutomaticTaxStatus | null;
  readonly clientReferenceId?: string | null;
  readonly paymentLinkId?: string | null;
  readonly confirmationMessage?: string | null;
  readonly linkOperationKey?: string | null;
  /** Default: 24 hours from now. */
  readonly expiresAt?: Date;
  readonly lineItems?: readonly NewLineItem[];
}

const DEFAULT_SESSION_LIFETIME_MS = 24 * 3600_000;

/**
 * Create a session (and its line items, in the caller's transaction or one of
 * its own). Mints the session's client secret.
 *
 * @returns the row, or `null` when `paymentIntentId` is ALREADY wrapped by
 *   another session — "a payment is one session's" is a unique index, and the
 *   loser of two concurrent wraps re-reads the winner.
 */
export async function insertCheckoutSession(
  db: DatabaseOrTransaction,
  params: InsertCheckoutSessionParams,
): Promise<CheckoutSessionRow | null> {
  const mode = params.mode ?? 'payment';
  const totals = params.totals ?? {
    amountSubtotal: params.amount,
    amountDiscount: '0',
    amountTax: '0',
    amountShipping: '0',
    amountTotal: params.amount,
  };
  const write = async (tx: DatabaseOrTransaction): Promise<CheckoutSessionRow | null> => {
    const [row] = await tx
      .insert(checkoutSessions)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        oxyAppId: params.oxyAppId,
        environment: params.environment,
        mode,
        status: 'open',
        paymentStatus: mode === 'setup' ? 'no_payment_required' : 'unpaid',
        uiMode: params.uiMode ?? 'hosted',
        locale: params.locale ?? null,
        submitType: params.submitType ?? 'auto',
        clientSecret: clientSecretFor(params.publicId),
        paymentIntentId: params.paymentIntentId ?? null,
        amount: totals.amountTotal,
        amountSubtotal: totals.amountSubtotal,
        amountDiscount: totals.amountDiscount,
        amountTax: totals.amountTax,
        amountShipping: totals.amountShipping,
        currency: params.currency,
        rail: params.rail,
        network: params.network,
        connectedAccountId: params.connectedAccountId ?? null,
        customerId: params.customerId ?? null,
        customerEmail: params.customerEmail ?? null,
        customerCreation: params.customerCreation ?? 'if_required',
        collection: params.collection ?? null,
        customFields: [...(params.customFields ?? [])],
        allowPromotionCodes: params.allowPromotionCodes ?? false,
        couponId: params.couponId ?? null,
        promotionCodeId: params.promotionCodeId ?? null,
        automaticTax: params.automaticTax ?? false,
        automaticTaxStatus: params.automaticTaxStatus ?? null,
        clientReferenceId: params.clientReferenceId ?? null,
        paymentLinkId: params.paymentLinkId ?? null,
        confirmationMessage: params.confirmationMessage ?? null,
        linkOperationKey: params.linkOperationKey ?? null,
        metadata: params.metadata,
        successUrl: params.successUrl ?? null,
        cancelUrl: params.cancelUrl ?? null,
        expiresAt: params.expiresAt ?? new Date(Date.now() + DEFAULT_SESSION_LIFETIME_MS),
      })
      .onConflictDoNothing()
      .returning(SESSION_COLUMNS);
    if (!row) return null;
    const session = toSessionRow(row);
    const lines = params.lineItems ?? [];
    if (lines.length > 0) {
      await tx.insert(checkoutSessionLineItems).values(
        lines.map((line, position) => ({
          id: uuidv7(),
          publicId: newId('li'),
          sessionId: session.id,
          merchantId: session.merchantId,
          position,
          priceId: line.priceId,
          productId: line.productId,
          description: line.description,
          images: [...line.images],
          taxCode: line.taxCode,
          taxBehavior: line.taxBehavior,
          currency: line.currency,
          price: line.price,
          quantity: line.quantity,
          adjustableEnabled: line.adjustable !== null,
          adjustableMinimum: line.adjustable?.minimum ?? null,
          adjustableMaximum: line.adjustable?.maximum ?? null,
          amountSubtotal: line.amountSubtotal,
          amountDiscount: line.amountDiscount,
          amountTax: line.amountTax,
          amountTotal: line.amountTotal,
        })),
      );
    }
    return session;
  };
  try {
    // Session and lines commit together; on a caller's transaction this is a
    // savepoint, so the loser of a unique race rolls back only its own work.
    return await db.transaction((tx) => write(tx));
  } catch (error) {
    if (
      isUniqueViolation(error, 'checkout_sessions_payment_intent_id_key') ||
      isUniqueViolation(error, 'checkout_sessions_link_operation_key')
    ) {
      return null;
    }
    throw error;
  }
}

// ---- Reads -----------------------------------------------------------------------

/** The session wrapping this payment (its INTERNAL id) — unique, so at most one. */
export async function findSessionByIntentId(
  db: DatabaseOrTransaction,
  paymentIntentId: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(eq(checkoutSessions.paymentIntentId, paymentIntentId));
  return row ? toSessionRow(row) : null;
}

/** The session wrapping this SetupIntent (its INTERNAL id). */
export async function findSessionBySetupIntentId(
  db: DatabaseOrTransaction,
  setupIntentId: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(eq(checkoutSessions.setupIntentId, setupIntentId));
  return row ? toSessionRow(row) : null;
}

/** The PAYER read: `cs_…` alone, authorized by a client secret the caller checks. */
export async function findSessionByPublicId(
  db: DatabaseOrTransaction,
  publicId: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(eq(checkoutSessions.publicId, publicId));
  return row ? toSessionRow(row) : null;
}

/** The MERCHANT read: ownership in the WHERE clause, so a foreign session 404s like a missing one. */
export async function findSessionForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(
      and(eq(checkoutSessions.publicId, publicId), eq(checkoutSessions.merchantId, merchantId)),
    );
  return row ? toSessionRow(row) : null;
}

export async function findSessionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(eq(checkoutSessions.id, id));
  return row ? toSessionRow(row) : null;
}

/** Lock a session for the rest of the caller's transaction (`FOR UPDATE`). */
export async function lockSession(
  tx: DatabaseOrTransaction,
  id: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await tx
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(eq(checkoutSessions.id, id))
    .for('update');
  return row ? toSessionRow(row) : null;
}

export interface ListSessionsParams {
  readonly merchantId: string;
  readonly paymentIntentId?: string | undefined;
  readonly paymentLinkId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly status?: CheckoutSessionStatus | undefined;
  readonly page: KeysetPage;
}

/** Sessions a merchant owns, newest first (`db/keyset.ts`). */
export async function listSessionsForMerchant(
  db: DatabaseOrTransaction,
  params: ListSessionsParams,
): Promise<{ data: CheckoutSessionRow[]; hasMore: boolean }> {
  const walk = keyset(checkoutSessions.id, checkoutSessions.createdAt, params.page);
  const rows = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(
      and(
        eq(checkoutSessions.merchantId, params.merchantId),
        params.paymentIntentId === undefined
          ? undefined
          : eq(checkoutSessions.paymentIntentId, params.paymentIntentId),
        params.paymentLinkId === undefined
          ? undefined
          : eq(checkoutSessions.paymentLinkId, params.paymentLinkId),
        params.customerId === undefined
          ? undefined
          : eq(checkoutSessions.customerId, params.customerId),
        params.status === undefined ? undefined : eq(checkoutSessions.status, params.status),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toSessionRow));
}

/** Every line of a session, in order. */
export async function listLineItems(
  db: DatabaseOrTransaction,
  sessionId: string,
): Promise<CheckoutLineItemRow[]> {
  const rows = await db
    .select(LINE_COLUMNS)
    .from(checkoutSessionLineItems)
    .where(eq(checkoutSessionLineItems.sessionId, sessionId))
    .orderBy(asc(checkoutSessionLineItems.position));
  return rows.map(toLineRow);
}

/** The lines of several sessions, by session (one query for a page). */
export async function listLineItemsForSessions(
  db: DatabaseOrTransaction,
  sessionIds: readonly string[],
): Promise<Map<string, CheckoutLineItemRow[]>> {
  const map = new Map<string, CheckoutLineItemRow[]>();
  if (sessionIds.length === 0) return map;
  const rows = await db
    .select(LINE_COLUMNS)
    .from(checkoutSessionLineItems)
    .where(inArray(checkoutSessionLineItems.sessionId, [...sessionIds]))
    .orderBy(asc(checkoutSessionLineItems.position));
  for (const row of rows.map(toLineRow)) {
    const list = map.get(row.sessionId) ?? [];
    list.push(row);
    map.set(row.sessionId, list);
  }
  return map;
}

/** A line item by its `li_…`, scoped to the session — the cursor of `/line_items`. */
export async function findLineItemInSession(
  db: DatabaseOrTransaction,
  sessionId: string,
  publicId: string,
): Promise<CheckoutLineItemRow | null> {
  const [row] = await db
    .select(LINE_COLUMNS)
    .from(checkoutSessionLineItems)
    .where(
      and(
        eq(checkoutSessionLineItems.sessionId, sessionId),
        eq(checkoutSessionLineItems.publicId, publicId),
      ),
    );
  return row ? toLineRow(row) : null;
}

// ---- Writes ----------------------------------------------------------------------

/** Merge the merchant's metadata — `POST /v1/checkout_sessions/:id`. */
export async function updateSessionMetadata(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
  patch: MetadataPatch,
): Promise<CheckoutSessionRow | 'missing' | 'limit_exceeded'> {
  const scope = and(
    eq(checkoutSessions.publicId, publicId),
    eq(checkoutSessions.merchantId, merchantId),
  );
  const merged = mergedMetadata(checkoutSessions.metadata, patch);
  const [row] = await db
    .update(checkoutSessions)
    .set({ metadata: merged })
    .where(and(scope, metadataWithinLimit(merged)))
    .returning(SESSION_COLUMNS);
  if (row) return toSessionRow(row);
  const [exists] = await db.select({ id: checkoutSessions.id }).from(checkoutSessions).where(scope);
  return exists ? 'limit_exceeded' : 'missing';
}

/** What the payer's edit (and its re-pricing) writes. */
export interface SessionOrderPatch {
  readonly totals: SessionTotals;
  readonly lines: readonly {
    readonly id: string;
    readonly quantity: number;
    readonly amountSubtotal: string;
    readonly amountDiscount: string;
    readonly amountTax: string;
    readonly amountTotal: string;
  }[];
  readonly customerDetails?: CheckoutCustomerDetails | null;
  readonly shippingDetails?: CheckoutShippingDetails | null;
  readonly customFields?: readonly StoredCustomField[];
  readonly consent?: CheckoutConsent | null;
  readonly couponId?: string | null;
  readonly promotionCodeId?: string | null;
  readonly automaticTaxStatus?: AutomaticTaxStatus | null;
  readonly taxCalculationId?: string | null;
}

/**
 * Write the payer's edit of an OPEN, UNCONFIRMED order — in the caller's
 * transaction, which holds the session lock. `false` when the session is no
 * longer open or already has its payment (the edit lost a race with confirm
 * or expiry and writes nothing).
 */
export async function writeSessionOrder(
  tx: Transaction,
  sessionId: string,
  patch: SessionOrderPatch,
): Promise<boolean> {
  const updated = await tx
    .update(checkoutSessions)
    .set({
      amount: patch.totals.amountTotal,
      amountSubtotal: patch.totals.amountSubtotal,
      amountDiscount: patch.totals.amountDiscount,
      amountTax: patch.totals.amountTax,
      amountShipping: patch.totals.amountShipping,
      ...(patch.customerDetails !== undefined ? { customerDetails: patch.customerDetails } : {}),
      ...(patch.shippingDetails !== undefined ? { shippingDetails: patch.shippingDetails } : {}),
      ...(patch.customFields !== undefined ? { customFields: [...patch.customFields] } : {}),
      ...(patch.consent !== undefined ? { consent: patch.consent } : {}),
      ...(patch.couponId !== undefined ? { couponId: patch.couponId } : {}),
      ...(patch.promotionCodeId !== undefined ? { promotionCodeId: patch.promotionCodeId } : {}),
      ...(patch.automaticTaxStatus !== undefined
        ? { automaticTaxStatus: patch.automaticTaxStatus }
        : {}),
      ...(patch.taxCalculationId !== undefined ? { taxCalculationId: patch.taxCalculationId } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(checkoutSessions.id, sessionId),
        eq(checkoutSessions.status, 'open'),
        isNull(checkoutSessions.paymentIntentId),
        isNull(checkoutSessions.setupIntentId),
      ),
    )
    .returning({ id: checkoutSessions.id });
  if (updated.length === 0) return false;
  for (const line of patch.lines) {
    await tx
      .update(checkoutSessionLineItems)
      .set({
        quantity: line.quantity,
        amountSubtotal: line.amountSubtotal,
        amountDiscount: line.amountDiscount,
        amountTax: line.amountTax,
        amountTotal: line.amountTotal,
        updatedAt: now,
      })
      .where(
        and(
          eq(checkoutSessionLineItems.id, line.id),
          eq(checkoutSessionLineItems.sessionId, sessionId),
        ),
      );
  }
  return true;
}

/**
 * Link the confirmed payment (or setup) to an OPEN session that has none —
 * or already has THIS one (a retried confirm). `false` when the session moved.
 */
export async function linkSessionObject(
  tx: DatabaseOrTransaction,
  sessionId: string,
  link: { readonly paymentIntentId: string } | { readonly setupIntentId: string },
  extra: { readonly customerId?: string | null } = {},
): Promise<CheckoutSessionRow | null> {
  const target =
    'paymentIntentId' in link
      ? {
          set: { paymentIntentId: link.paymentIntentId },
          free: or(
            isNull(checkoutSessions.paymentIntentId),
            eq(checkoutSessions.paymentIntentId, link.paymentIntentId),
          ),
        }
      : {
          set: { setupIntentId: link.setupIntentId },
          free: or(
            isNull(checkoutSessions.setupIntentId),
            eq(checkoutSessions.setupIntentId, link.setupIntentId),
          ),
        };
  const [row] = await tx
    .update(checkoutSessions)
    .set({
      ...target.set,
      ...(extra.customerId !== undefined ? { customerId: extra.customerId } : {}),
      updatedAt: now,
    })
    .where(
      and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.status, 'open'), target.free),
    )
    .returning(SESSION_COLUMNS);
  return row ? toSessionRow(row) : null;
}

/**
 * `open → complete`, the one writer of completion. `null` when the session was
 * not open (already complete, or expired) — the caller records nothing.
 */
export async function completeSession(
  tx: DatabaseOrTransaction,
  sessionId: string,
  paymentStatus: CheckoutSessionPaymentStatus,
  extra: { readonly customerId?: string | null } = {},
): Promise<CheckoutSessionRow | null> {
  const [row] = await tx
    .update(checkoutSessions)
    .set({
      status: 'complete',
      paymentStatus,
      completedAt: now,
      ...(extra.customerId !== undefined ? { customerId: extra.customerId } : {}),
      updatedAt: now,
    })
    .where(and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.status, 'open')))
    .returning(SESSION_COLUMNS);
  return row ? toSessionRow(row) : null;
}

/** A completed session's asynchronous payment arrived: `unpaid → paid`. */
export async function markSessionPaid(
  tx: DatabaseOrTransaction,
  sessionId: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await tx
    .update(checkoutSessions)
    .set({ paymentStatus: 'paid', updatedAt: now })
    .where(
      and(
        eq(checkoutSessions.id, sessionId),
        eq(checkoutSessions.status, 'complete'),
        eq(checkoutSessions.paymentStatus, 'unpaid'),
      ),
    )
    .returning(SESSION_COLUMNS);
  return row ? toSessionRow(row) : null;
}

/** `open → expired`. `null` when it was not open. */
export async function expireSessionRow(
  tx: DatabaseOrTransaction,
  sessionId: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await tx
    .update(checkoutSessions)
    .set({ status: 'expired', expiredAt: now, updatedAt: now })
    .where(and(eq(checkoutSessions.id, sessionId), eq(checkoutSessions.status, 'open')))
    .returning(SESSION_COLUMNS);
  return row ? toSessionRow(row) : null;
}

/**
 * The expiry sweeper's claim: open sessions past their deadline whose payment
 * cannot still arrive — none was created, or it was cancelled. A session whose
 * payment is open expires WITH that payment (its deadline is the session's,
 * and the intent sweeper cancels it), and one whose payment is in flight is not
 * expired at all. `for update skip locked`, so two tasks never claim one row.
 */
export async function expireDueSessions(
  tx: Transaction,
  limit: number,
): Promise<CheckoutSessionRow[]> {
  const due = tx
    .select({ id: checkoutSessions.id })
    .from(checkoutSessions)
    .leftJoin(paymentIntents, eq(paymentIntents.id, checkoutSessions.paymentIntentId))
    .where(
      and(
        eq(checkoutSessions.status, 'open'),
        lte(checkoutSessions.expiresAt, sql`now()`),
        or(isNull(checkoutSessions.paymentIntentId), eq(paymentIntents.status, 'canceled')),
      ),
    )
    .limit(limit)
    .for('update', { of: checkoutSessions, skipLocked: true });
  const rows = await tx
    .update(checkoutSessions)
    .set({ status: 'expired', expiredAt: now, updatedAt: now })
    .where(and(inArray(checkoutSessions.id, due), eq(checkoutSessions.status, 'open')))
    .returning(SESSION_COLUMNS);
  return rows.map(toSessionRow);
}

/**
 * How many OPEN sessions other than `exceptId` hold a confirmed payment with
 * this promotion code / coupon — the redemptions reserved but not yet
 * counted. Read under the code's row lock (`lockPromotionCode`).
 */
export async function countReservedRedemptions(
  tx: Transaction,
  target: { readonly promotionCodeId: string } | { readonly couponId: string },
  exceptId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(checkoutSessions)
    .where(
      and(
        'promotionCodeId' in target
          ? eq(checkoutSessions.promotionCodeId, target.promotionCodeId)
          : eq(checkoutSessions.couponId, target.couponId),
        eq(checkoutSessions.status, 'open'),
        or(
          sql`${checkoutSessions.paymentIntentId} is not null`,
          sql`${checkoutSessions.setupIntentId} is not null`,
        ),
        sql`${checkoutSessions.id} <> ${exceptId}`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Whether this payer already paid this merchant — a promotion code's
 * `first_time_transaction`. By the customer when there is one, and by email
 * (a payment's receipt email, or a customer of that email) otherwise.
 */
export async function hasSucceededPayment(
  db: DatabaseOrTransaction,
  merchantId: string,
  payer: { readonly customerId: string | null; readonly email: string | null },
): Promise<boolean> {
  if (payer.customerId === null && payer.email === null) return false;
  const rows = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from payment_intents pi
      left join customers c on c.id = pi.customer_id
      where pi.merchant_id = ${merchantId} and pi.status = 'succeeded' and (
        (${payer.customerId}::text is not null and pi.customer_id = ${payer.customerId}::text)
        or (${payer.email}::text is not null and (lower(pi.receipt_email) = lower(${payer.email}::text) or lower(c.email) = lower(${payer.email}::text)))
      )
    ) as found`);
  return [...rows][0]?.found === true;
}

/** The session a payer started from a link under this operation key, if any. */
export async function findSessionByLinkOperation(
  db: DatabaseOrTransaction,
  paymentLinkId: string,
  operationKey: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(checkoutSessions)
    .where(
      and(
        eq(checkoutSessions.paymentLinkId, paymentLinkId),
        eq(checkoutSessions.linkOperationKey, operationKey),
      ),
    );
  return row ? toSessionRow(row) : null;
}

/** The customer a completion created (`customer_creation: always`), in its transaction. */
export async function setSessionCustomer(
  tx: DatabaseOrTransaction,
  sessionId: string,
  customerId: string,
): Promise<CheckoutSessionRow | null> {
  const [row] = await tx
    .update(checkoutSessions)
    .set({ customerId, updatedAt: now })
    .where(and(eq(checkoutSessions.id, sessionId), isNull(checkoutSessions.customerId)))
    .returning(SESSION_COLUMNS);
  return row ? toSessionRow(row) : null;
}
