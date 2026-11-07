import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  unixSecondsParam,
} from '../../common/params';
import { amount, currency, livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { AUTOMATIC_TAX_STATUSES } from '../../vocabulary/invoices';
import { QUOTE_LIMITS, QUOTE_STATUSES } from '../../vocabulary/quotes';
import { COLLECTION_METHODS } from '../../vocabulary/subscriptions';
import { checkoutLineItemSchema } from '../checkout/shared';
import { automaticTaxParam, daysUntilDueParam, discountsParam, shortText } from './params';
import { discountSchema } from './subscriptions';

/**
 * Quotes (`qt_…`) — Stripe's Quotes on Orbit's native billing engine (ADR 0018
 * §5). A quote prices catalog Prices for one customer: a `draft` is edited,
 * `finalize` numbers it and fixes its discount and Peable Tax (failing closed,
 * never zero), and `accept` turns it into native billing objects — an invoice
 * for one-time lines, a subscription with its first invoice for recurring ones
 * (one-time lines then ride on that first invoice). Its lines are Stripe's
 * `item`, the same object a Checkout Session's lines are.
 */

const totalDetailsSchema = z
  .object({
    amount_discount: amount,
    amount_shipping: amount.describe('Always `0`: a quote ships nothing.'),
    amount_tax: amount
      .nullable()
      .describe(
        'Every tax, inclusive and exclusive; `null` on a draft whose tax is not known yet.',
      ),
  })
  .strict();

export const quoteSchema = defineObject(
  'quote',
  'Quote',
  z
    .object({
      id: z.string(),
      object: z.literal('quote'),
      livemode,
      number: z
        .string()
        .nullable()
        .describe('`null` while a draft; `QT-PREFIX-0001` once finalized — per merchant.'),
      status: z.enum(QUOTE_STATUSES),
      customer: expandable('customer', '`cus_…`, or the Customer with `expand[]=customer`.'),
      currency,
      collection_method: z.enum(COLLECTION_METHODS),
      invoice_settings: z
        .object({
          days_until_due: z
            .number()
            .int()
            .nullable()
            .describe("`send_invoice` only; the billing settings' default when `null`."),
        })
        .strict(),
      subscription_data: z
        .object({
          description: z.string().nullable(),
          trial_period_days: z.number().int().nullable(),
          metadata,
        })
        .strict()
        .describe('What the subscription an accepted quote with recurring lines starts with.'),
      discount: discountSchema.nullable(),
      automatic_tax: z
        .object({
          enabled: z.boolean(),
          status: z.enum(AUTOMATIC_TAX_STATUSES).nullable(),
          tax_calculation: z
            .string()
            .nullable()
            .describe('The Peable Tax calculation (`taxcalc_…`) the quote finalized with.'),
        })
        .strict(),
      amount_subtotal: amount.describe(
        'Every line before discount and tax (one period of a recurring line).',
      ),
      amount_total: amount.describe('`amount_subtotal - amount_discount + exclusive tax`.'),
      total_details: totalDetailsSchema,
      expires_at: unixSeconds.describe('An open quote is cancelled at this instant.'),
      header: z.string().nullable(),
      description: z.string().nullable(),
      footer: z.string().nullable(),
      invoice: expandable(
        'invoice',
        "The invoice accepting made (`in_…`, expandable): the one-time invoice, or the subscription's first.",
      ).nullable(),
      subscription: expandable(
        'subscription',
        'The subscription accepting made (`sub_…`, expandable); `null` without recurring lines.',
      ).nullable(),
      status_transitions: z
        .object({
          finalized_at: unixSeconds.nullable(),
          accepted_at: unixSeconds.nullable(),
          canceled_at: unixSeconds.nullable(),
        })
        .strict(),
      test_clock: z.string().nullable(),
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'qt_0193b8f2c1a87d3e9f4a',
        object: 'quote',
        livemode: false,
        number: 'QT-ACME-0001',
        status: 'open',
        customer: 'cus_0193b8f2c1a87d3e9f4a',
        currency: 'EUR',
        collection_method: 'send_invoice',
        invoice_settings: { days_until_due: 30 },
        subscription_data: { description: null, trial_period_days: null, metadata: {} },
        discount: null,
        automatic_tax: { enabled: false, status: null, tax_calculation: null },
        amount_subtotal: '120000',
        amount_total: '120000',
        total_details: { amount_discount: '0', amount_shipping: '0', amount_tax: '0' },
        expires_at: 1796342400,
        header: 'Annual support',
        description: null,
        footer: null,
        invoice: null,
        subscription: null,
        status_transitions: { finalized_at: 1793750400, accepted_at: null, canceled_at: null },
        test_clock: null,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type Quote = Expand<z.output<typeof quoteSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    quote: Quote;
  }
}

// ---- Requests ------------------------------------------------------------------------

const quoteLineItemParams = z
  .object({
    price: idParam.describe(
      'An active, licensed catalog Price (`price_…`), one-time or recurring.',
    ),
    quantity: z
      .number()
      .int()
      .min(1)
      .max(QUOTE_LIMITS.quantityMax)
      .optional()
      .describe('Default 1.'),
  })
  .strict();

const lineItemsParam = z
  .array(quoteLineItemParams)
  .min(1)
  .max(QUOTE_LIMITS.lineItemsMax)
  .describe(
    'Each price once, in one currency; every recurring price on one interval. Replaces every line on an update.',
  );

const invoiceSettingsParam = z.object({ days_until_due: daysUntilDueParam.optional() }).strict();

const subscriptionDataParam = z
  .object({
    description: shortText(500).optional(),
    trial_period_days: z.number().int().min(1).max(QUOTE_LIMITS.trialPeriodDaysMax).optional(),
    metadata: metadataCreateParam.optional(),
  })
  .strict();

export const createQuoteParams = z
  .object({
    customer: idParam,
    line_items: lineItemsParam,
    collection_method: z
      .enum(COLLECTION_METHODS)
      .optional()
      .describe(
        'Default `charge_automatically`; a FairCoin (`FAIR`) quote is always `send_invoice`.',
      ),
    invoice_settings: invoiceSettingsParam.optional(),
    subscription_data: subscriptionDataParam.optional(),
    discounts: discountsParam.optional().describe('At most one: a coupon or a promotion code.'),
    automatic_tax: automaticTaxParam.optional(),
    expires_at: unixSecondsParam
      .optional()
      .describe("Default: 30 days from now (the customer's test clock time when it has one)."),
    header: shortText(QUOTE_LIMITS.headerMax).optional(),
    description: shortText(QUOTE_LIMITS.descriptionMax).optional(),
    footer: shortText(QUOTE_LIMITS.footerMax).optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateQuoteParams = z.input<typeof createQuoteParams>;

/** Drafts only, except `metadata`. A field sent as `""` is cleared. */
export const updateQuoteParams = z
  .object({
    line_items: lineItemsParam.optional(),
    collection_method: z.enum(COLLECTION_METHODS).optional(),
    invoice_settings: invoiceSettingsParam.optional(),
    subscription_data: subscriptionDataParam.optional(),
    discounts: z.union([discountsParam, z.literal('')]).optional(),
    automatic_tax: automaticTaxParam.optional(),
    expires_at: unixSecondsParam.optional(),
    header: z.union([shortText(QUOTE_LIMITS.headerMax), z.literal('')]).optional(),
    description: z.union([shortText(QUOTE_LIMITS.descriptionMax), z.literal('')]).optional(),
    footer: z.union([shortText(QUOTE_LIMITS.footerMax), z.literal('')]).optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateQuoteParams = z.input<typeof updateQuoteParams>;

export const finalizeQuoteParams = z
  .object({
    expires_at: unixSecondsParam.optional().describe('A new expiry, set as it finalizes.'),
    expand: expandParam.optional(),
  })
  .strict();
export type FinalizeQuoteParams = z.input<typeof finalizeQuoteParams>;

/** The body of `accept` and `cancel`: nothing but `expand[]`. */
export const quoteActionParams = z.object({ expand: expandParam.optional() }).strict();
export type QuoteActionParams = z.input<typeof quoteActionParams>;

export const listQuotesQuery = listQuery({
  customer: idParam.optional(),
  status: z.enum(QUOTE_STATUSES).optional(),
});
export type QuoteListParams = z.input<typeof listQuotesQuery>;

/** A quote's lines, in their order; `created` does not apply to them. */
export const listQuoteLineItemsQuery = listQuery({});
export type QuoteLineItemListParams = z.input<typeof listQuoteLineItemsQuery>;

// ---- Routes --------------------------------------------------------------------------

const quoteId = { id: 'The quote (`qt_…`).' } as const;

export const quoteRoutes = [
  defineRoute({
    operationId: 'createQuote',
    method: 'post',
    path: '/v1/quotes',
    tag: 'Quotes',
    summary: 'Create a quote',
    description:
      "A draft for one customer, priced from catalog Prices with the catalog's own pricing. Its tax is computed when it finalizes.",
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createQuoteParams,
    response: quoteSchema,
    sdk: 'quotes.create',
    expandable: 'quote',
  }),
  defineRoute({
    operationId: 'listQuotes',
    method: 'get',
    path: '/v1/quotes',
    tag: 'Quotes',
    summary: 'List quotes',
    auth: 'service',
    scope: 'payments:read',
    query: listQuotesQuery,
    response: listOf(quoteSchema),
    sdk: 'quotes.list',
    expandable: 'quote',
  }),
  defineRoute({
    operationId: 'retrieveQuote',
    method: 'get',
    path: '/v1/quotes/{id}',
    tag: 'Quotes',
    summary: 'Retrieve a quote',
    auth: 'service',
    scope: 'payments:read',
    params: quoteId,
    query: expandOnlyQuery,
    response: quoteSchema,
    sdk: 'quotes.retrieve',
    expandable: 'quote',
  }),
  defineRoute({
    operationId: 'updateQuote',
    method: 'post',
    path: '/v1/quotes/{id}',
    tag: 'Quotes',
    summary: 'Update a quote',
    description:
      'Drafts only, except `metadata`. `line_items` replaces every line; a field sent as `""` is cleared; `metadata` is a patch.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: quoteId,
    body: updateQuoteParams,
    response: quoteSchema,
    sdk: 'quotes.update',
    expandable: 'quote',
  }),
  defineRoute({
    operationId: 'finalizeQuote',
    method: 'post',
    path: '/v1/quotes/{id}/finalize',
    tag: 'Quotes',
    summary: 'Finalize a draft quote',
    description:
      'It gets its number, its discount and its Peable Tax. Tax fails closed: a quote whose tax cannot be computed stays a draft (`automatic_tax.status` says why).',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: quoteId,
    body: finalizeQuoteParams,
    response: quoteSchema,
    sdk: 'quotes.finalizeQuote',
    expandable: 'quote',
  }),
  defineRoute({
    operationId: 'acceptQuote',
    method: 'post',
    path: '/v1/quotes/{id}/accept',
    tag: 'Quotes',
    summary: 'Accept an open quote',
    description:
      'The customer said yes. One-time lines become an invoice; recurring lines a subscription whose first invoice also carries the one-time lines. The invoice is finalized (tax before finalize) and collected as the engine collects any other: charged when `charge_automatically` and the customer has a card, otherwise paid on its hosted page — where FairCoin is always offered.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: quoteId,
    body: quoteActionParams,
    response: quoteSchema,
    sdk: 'quotes.accept',
    expandable: 'quote',
  }),
  defineRoute({
    operationId: 'cancelQuote',
    method: 'post',
    path: '/v1/quotes/{id}/cancel',
    tag: 'Quotes',
    summary: 'Cancel a quote',
    description: 'A draft or an open quote; an accepted one cannot be cancelled.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: quoteId,
    body: quoteActionParams,
    response: quoteSchema,
    sdk: 'quotes.cancel',
    expandable: 'quote',
  }),
  defineRoute({
    operationId: 'listQuoteLineItems',
    method: 'get',
    path: '/v1/quotes/{id}/line_items',
    tag: 'Quotes',
    summary: "List a quote's line items",
    description: "In their order (at most twenty); the cursor is a line's own `li_…`.",
    auth: 'service',
    scope: 'payments:read',
    params: quoteId,
    query: listQuoteLineItemsQuery,
    response: listOf(checkoutLineItemSchema),
    sdk: 'quotes.listLineItems',
    expandable: 'item',
  }),
  defineRoute({
    operationId: 'retrieveQuotePdf',
    method: 'get',
    path: '/v1/quotes/{id}/pdf',
    tag: 'Quotes',
    summary: "Download a quote's PDF",
    description: 'A draft renders marked as a draft, without a number.',
    auth: 'service',
    scope: 'payments:read',
    params: quoteId,
    response: { kind: 'binary', contentType: 'application/pdf' },
    sdk: 'quotes.pdf',
  }),
] as const;
