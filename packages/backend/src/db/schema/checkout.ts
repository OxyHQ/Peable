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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import type { PriceRecurring } from '@peable.to/shared-types';
import { prices, products } from './catalog';
import { merchants } from './merchants';
import { invoices } from './billingEngine';
import { checkoutSessions, paymentIntents, paymentLinks } from './payments';
import { refunds } from './refunds';
import type { StoredPriceTier } from './catalog';
import {
  BASE_UNIT_STRING_PATTERN,
  BRANDING_BORDER_STYLES,
  BRANDING_FONTS,
  CURRENCY_CODES,
  CUSTOMER_EMAIL_KINDS,
  CUSTOMER_EMAIL_STATUSES,
  PRICE_TAX_BEHAVIORS,
} from './valueSets';

/**
 * A line's price AS PRICED — a snapshot of the stored price (or the inline
 * `price_data`) the line was created with, so a quantity the payer changes is
 * re-priced by the same rule even if the catalog price is archived meanwhile.
 * Prices are immutable, so for a catalog line this IS the price.
 */
export interface StoredLinePrice {
  readonly billingScheme: 'per_unit' | 'tiered';
  readonly unitAmount: string | null;
  readonly tiers: readonly StoredPriceTier[] | null;
  readonly tiersMode: 'graduated' | 'volume' | null;
  readonly transformQuantity: { divideBy: number; round: 'up' | 'down' } | null;
  readonly recurring: Pick<PriceRecurring, 'interval' | 'interval_count'> | null;
}

const amountColumns = ['amount_subtotal', 'amount_discount', 'amount_tax', 'amount_total'];

/**
 * One line of a Checkout Session (Stripe's `item`, `li_…`).
 *
 * The amounts are the session's last pricing of the line — written by the one
 * pricer (`services/checkout/pricing.ts`) in the statement that writes the
 * session's totals, so a line and its session cannot disagree.
 */
export const checkoutSessionLineItems = pgTable(
  'checkout_session_line_items',
  {
    id: generatedId(),
    /** The public `li_…`. */
    publicId: text().notNull(),
    sessionId: text()
      .notNull()
      .references(() => checkoutSessions.id, { onDelete: 'restrict' }),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    position: integer().notNull(),
    /** The catalog price, or NULL for an inline `price_data` line. */
    priceId: text(),
    /** The catalog product, or NULL for `product_data` (and for a contribution). */
    productId: text(),
    description: text().notNull(),
    images: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    taxCode: text(),
    taxBehavior: text().notNull().default('unspecified'),
    currency: text().notNull(),
    price: jsonb().$type<StoredLinePrice>().notNull(),
    quantity: integer().notNull(),
    adjustableEnabled: boolean().notNull().default(false),
    adjustableMinimum: integer(),
    adjustableMaximum: integer(),
    amountSubtotal: text().notNull(),
    amountDiscount: text().notNull().default('0'),
    amountTax: text().notNull().default('0'),
    amountTotal: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('checkout_session_line_items_public_id_key').on(table.publicId),
    uniqueIndex('checkout_session_line_items_session_position_key').on(
      table.sessionId,
      table.position,
    ),
    foreignKey({
      name: 'checkout_session_line_items_price_fkey',
      columns: [table.priceId, table.merchantId],
      foreignColumns: [prices.id, prices.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'checkout_session_line_items_product_fkey',
      columns: [table.productId, table.merchantId],
      foreignColumns: [products.id, products.merchantId],
    }).onDelete('restrict'),
    check(
      'checkout_session_line_items_amounts_check',
      sql.raw(amountColumns.map((c) => `${c} ~ '${BASE_UNIT_STRING_PATTERN}'`).join(' and ')),
    ),
    check(
      'checkout_session_line_items_currency_check',
      sql.raw(`currency in (${inList(CURRENCY_CODES)})`),
    ),
    check(
      'checkout_session_line_items_tax_behavior_check',
      sql.raw(`tax_behavior in (${inList(PRICE_TAX_BEHAVIORS)})`),
    ),
    /**
     * The quantity sits inside the bounds the payer may move it in; a line
     * that cannot be adjusted has no bounds. Zero only where the minimum is.
     */
    check(
      'checkout_session_line_items_quantity_check',
      sql`${table.quantity} >= 0 and ${table.quantity} <= 999999 and (
        (not ${table.adjustableEnabled} and ${table.adjustableMinimum} is null and ${table.adjustableMaximum} is null and ${table.quantity} >= 1)
        or (${table.adjustableEnabled} and ${table.adjustableMinimum} is not null and ${table.adjustableMaximum} is not null
          and ${table.adjustableMinimum} >= 0 and ${table.adjustableMinimum} <= ${table.adjustableMaximum}
          and ${table.quantity} between ${table.adjustableMinimum} and ${table.adjustableMaximum}))`,
    ),
    check(
      'checkout_session_line_items_images_check',
      sql`jsonb_typeof(${table.images}) = 'array' and jsonb_array_length(${table.images}) <= 8`,
    ),
  ],
);

/**
 * One price of a payment link. Immutable once the link is shared — a payer
 * may hold a session priced from it — so only the link's writer inserts these
 * and nothing updates them.
 */
export const paymentLinkLineItems = pgTable(
  'payment_link_line_items',
  {
    id: generatedId(),
    linkId: text()
      .notNull()
      .references(() => paymentLinks.id, { onDelete: 'restrict' }),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    position: integer().notNull(),
    priceId: text().notNull(),
    quantity: integer().notNull(),
    adjustableEnabled: boolean().notNull().default(false),
    adjustableMinimum: integer(),
    adjustableMaximum: integer(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('payment_link_line_items_link_position_key').on(table.linkId, table.position),
    index('payment_link_line_items_price_id_idx').on(table.priceId),
    foreignKey({
      name: 'payment_link_line_items_price_fkey',
      columns: [table.priceId, table.merchantId],
      foreignColumns: [prices.id, prices.merchantId],
    }).onDelete('restrict'),
    check(
      'payment_link_line_items_quantity_check',
      sql`${table.quantity} >= 1 and ${table.quantity} <= 999999 and (
        (not ${table.adjustableEnabled} and ${table.adjustableMinimum} is null and ${table.adjustableMaximum} is null)
        or (${table.adjustableEnabled} and ${table.adjustableMinimum} is not null and ${table.adjustableMaximum} is not null
          and ${table.adjustableMinimum} >= 0 and ${table.adjustableMinimum} <= ${table.adjustableMaximum}
          and ${table.quantity} between ${table.adjustableMinimum} and ${table.adjustableMaximum}))`,
    ),
  ],
);

/**
 * A merchant's branding (Orbit Phase 3) — one row, created on first write.
 *
 * Every column is a closed set or a validated colour, so nothing stored here
 * can carry markup or a remote font onto a payer's page or into an email. The
 * icon is the merchant's avatar and the logo its `business_logo` File — both
 * governed where they live (`merchants`), never copied here.
 */
export const merchantBranding = pgTable(
  'merchant_branding',
  {
    merchantId: text()
      .primaryKey()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    useAvatarAsIcon: boolean().notNull().default(true),
    primaryColor: text(),
    accentColor: text(),
    font: text(),
    borderStyle: text(),
    /** Shown beside the consent checkbox when a session requires terms acceptance. */
    termsOfServiceUrl: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'merchant_branding_colors_check',
      sql`(${table.primaryColor} is null or ${table.primaryColor} ~ '^#[0-9a-f]{6}$') and (${table.accentColor} is null or ${table.accentColor} ~ '^#[0-9a-f]{6}$')`,
    ),
    check(
      'merchant_branding_font_check',
      sql.raw(`font is null or font in (${inList(BRANDING_FONTS)})`),
    ),
    check(
      'merchant_branding_border_style_check',
      sql.raw(`border_style is null or border_style in (${inList(BRANDING_BORDER_STYLES)})`),
    ),
    check(
      'merchant_branding_terms_url_check',
      sql`${table.termsOfServiceUrl} is null or (${table.termsOfServiceUrl} ~ '^https://' and length(${table.termsOfServiceUrl}) <= 2048)`,
    ),
  ],
);

/**
 * Which customer emails Peable sends for a merchant, and the merchant's
 * receipt counter. One row, created on first write or first receipt.
 *
 * `next_receipt_number` is claimed by ONE statement
 * (`claimReceiptNumber`: upsert, `RETURNING n - 1`), the derivation index's
 * pattern — two receipts can never be given the same number.
 */
export const merchantEmailSettings = pgTable(
  'merchant_email_settings',
  {
    merchantId: text()
      .primaryKey()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    paymentReceipts: boolean().notNull().default(true),
    refundNotices: boolean().notNull().default(true),
    checkoutConfirmations: boolean().notNull().default(false),
    supportEmail: text(),
    nextReceiptNumber: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('merchant_email_settings_receipt_number_check', sql`${table.nextReceiptNumber} >= 1`),
    check(
      'merchant_email_settings_support_email_check',
      sql`${table.supportEmail} is null or (length(${table.supportEmail}) <= 254 and ${table.supportEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+$')`,
    ),
  ],
);

/**
 * The customer-email outbox (Orbit Phase 3). A row is written in the
 * transaction of the change it reports — a payment succeeding, a refund
 * succeeding, a session completing — so an email is owed exactly when the
 * change committed. `services/customerEmails.ts` renders it at send time from
 * the rows it names and hands it to the injected mailer.
 *
 * `dedupe_key` (`<kind>:<subject id>`) makes the enqueue idempotent: a
 * re-applied transition cannot send a second receipt.
 */
export const customerEmails = pgTable(
  'customer_emails',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    kind: text().notNull(),
    dedupeKey: text().notNull(),
    recipient: text().notNull(),
    paymentIntentId: text().references(() => paymentIntents.id, { onDelete: 'restrict' }),
    refundId: text().references(() => refunds.id, { onDelete: 'restrict' }),
    checkoutSessionId: text().references(() => checkoutSessions.id, { onDelete: 'restrict' }),
    /** The invoice an `invoice` / `invoice_payment_failed` email is about (ADR 0018). */
    invoiceId: text(),
    /** A receipt's number — the merchant's sequence, claimed at enqueue. */
    receiptNumber: text(),
    status: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz().notNull().default(sql`date_trunc('milliseconds', now())`),
    sentAt: timestamptz(),
    lastError: text(),
    /** A receipt not sent by then is no longer worth sending. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('customer_emails_dedupe_key').on(table.dedupeKey),
    index('customer_emails_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index('customer_emails_merchant_id_idx').on(table.merchantId),
    foreignKey({
      name: 'customer_emails_invoice_fkey',
      columns: [table.invoiceId],
      foreignColumns: [invoices.id],
    }).onDelete('restrict'),
    check('customer_emails_kind_check', sql.raw(`kind in (${inList(CUSTOMER_EMAIL_KINDS)})`)),
    check(
      'customer_emails_status_check',
      sql.raw(`status in (${inList(CUSTOMER_EMAIL_STATUSES)})`),
    ),
    /** Each kind names exactly the object it is about. */
    check(
      'customer_emails_subject_check',
      sql`(${table.kind} = 'payment_receipt' and ${table.paymentIntentId} is not null and ${table.receiptNumber} is not null)
        or (${table.kind} = 'refund_notice' and ${table.refundId} is not null)
        or (${table.kind} = 'checkout_confirmation' and ${table.checkoutSessionId} is not null)
        or (${table.kind} in ('invoice', 'invoice_payment_failed') and ${table.invoiceId} is not null)`,
    ),
    check(
      'customer_emails_sent_check',
      sql`(${table.status} = 'sent') = (${table.sentAt} is not null)`,
    ),
    check(
      'customer_emails_recipient_check',
      sql`length(${table.recipient}) <= 254 and ${table.recipient} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`,
    ),
  ],
);
