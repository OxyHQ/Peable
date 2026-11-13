import { z } from 'zod';
import { embedded } from '../../common/objects';
import { deletedOf, listOf, searchResultOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  queryBoolean,
  queryInteger,
  queryUnixSeconds,
  rangeParam,
  searchQuery,
  unixSecondsParam,
} from '../../common/params';
import {
  amount,
  currency,
  livemode,
  metadata,
  signedAmount,
  unixSeconds,
} from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  AUTOMATIC_TAX_STATUSES,
  INVOICE_BILLING_REASONS,
  INVOICE_LINE_TYPES,
  INVOICE_STATUSES,
  PENDING_INVOICE_ITEMS_BEHAVIORS,
} from '../../vocabulary/invoices';
import { COLLECTION_METHODS, PRORATION_BEHAVIORS } from '../../vocabulary/subscriptions';
import {
  automaticTaxParam,
  currencyParam,
  daysUntilDueParam,
  discountsParam,
  shortText,
} from './params';
import { discountSchema } from './subscriptions';

/**
 * Invoices (`in_…`) and their lines (`il_…`) — Orbit's native billing engine
 * (ADR 0018 §2).
 *
 * ## Signed amounts
 *
 * Every amount is a base-unit STRING (ADR 0014 D1). Most are never negative;
 * the ones documented as SIGNED may start with `-`: a proration credit line,
 * an invoice whose credits exceed its charges, and a customer balance (where
 * negative is credit the customer holds, Stripe's convention). A signed amount
 * still has exactly one spelling: no `+`, no `-0`, no leading zeros.
 */

/** One tax amount on a line. */
export const invoiceTaxAmountSchema = defineComponent(
  'InvoiceTaxAmount',
  z
    .object({
      amount: signedAmount.describe('SIGNED: a credit line carries negative tax.'),
      inclusive: z.boolean(),
      tax_calculation: z
        .string()
        .nullable()
        .describe(
          'The Peable Tax calculation (`taxcalc_…`) it came from; `null` for a derived credit.',
        ),
      taxability_reason: z.string().nullable(),
    })
    .strict(),
);
export type InvoiceTaxAmount = z.output<typeof invoiceTaxAmountSchema>;

/** The amount a discount took off a line, or off the whole invoice. */
const discountAmountSchema = z
  .object({
    amount: signedAmount.describe('SIGNED: a discount on a credit line is negative.'),
    discount: z.string().describe('The discount it comes from.'),
  })
  .strict();

const periodSchema = z.object({ start: unixSeconds, end: unixSeconds }).strict();

export const invoiceLineItemSchema = defineObject(
  'line_item',
  'InvoiceLineItem',
  z
    .object({
      id: z.string(),
      object: z.literal('line_item'),
      livemode,
      invoice: z.string().describe('The invoice (`in_…`) it is on.'),
      type: z.enum(INVOICE_LINE_TYPES),
      amount: signedAmount.describe('SIGNED: before discounts; tax-inclusive when the price is.'),
      currency,
      description: z.string().nullable(),
      discount_amounts: z.array(discountAmountSchema),
      discountable: z.boolean(),
      period: periodSchema,
      price: embedded('price', 'The Price, embedded; `null` for a fixed-amount item.').nullable(),
      quantity: z.number().int().nullable(),
      proration: z.boolean(),
      subscription: z.string().nullable(),
      subscription_item: z.string().nullable(),
      invoice_item: z.string().nullable(),
      tax_amounts: z.array(invoiceTaxAmountSchema),
      metadata,
    })
    .strict(),
);
export type InvoiceLineItem = Expand<z.output<typeof invoiceLineItemSchema>>;

export const invoiceSchema = defineObject(
  'invoice',
  'Invoice',
  z
    .object({
      id: z.string(),
      object: z.literal('invoice'),
      livemode,
      number: z
        .string()
        .nullable()
        .describe('`null` while a draft; `PREFIX-0001` once finalized — gapless per merchant.'),
      customer: expandable('customer', '`cus_…`, or the Customer with `expand[]=customer`.'),
      customer_email: z.string().nullable(),
      customer_name: z.string().nullable(),
      subscription: expandable(
        'subscription',
        '`sub_…`, or the Subscription with `expand[]=subscription`.',
      ).nullable(),
      status: z.enum(INVOICE_STATUSES),
      billing_reason: z.enum(INVOICE_BILLING_REASONS),
      collection_method: z.enum(COLLECTION_METHODS),
      currency,
      description: z.string().nullable(),
      auto_advance: z.boolean(),
      automatically_finalizes_at: unixSeconds
        .nullable()
        .describe('When a draft with `auto_advance` will finalize.'),
      lines: listOf(invoiceLineItemSchema).describe('Every line, on one page.'),
      subtotal: signedAmount.describe('SIGNED. Sum of the lines before discounts.'),
      subtotal_excluding_tax: signedAmount.describe(
        'SIGNED. `subtotal` less the tax included in it (inclusive prices).',
      ),
      total_discount_amounts: z.array(discountAmountSchema),
      discount: discountSchema.nullable(),
      tax: signedAmount
        .nullable()
        .describe('SIGNED; `null` on a draft whose tax is not calculated yet.'),
      total: signedAmount.describe('SIGNED.'),
      total_excluding_tax: signedAmount.describe('SIGNED.'),
      starting_balance: signedAmount.describe(
        "SIGNED: the customer's balance applied when it finalized.",
      ),
      ending_balance: signedAmount
        .nullable()
        .describe("SIGNED: what the customer's balance became; `null` until finalized."),
      amount_due: amount,
      amount_paid: amount,
      amount_remaining: amount,
      pre_payment_credit_notes_amount: amount,
      post_payment_credit_notes_amount: amount,
      attempt_count: z.number().int().nonnegative(),
      attempted: z.boolean(),
      next_payment_attempt: unixSeconds.nullable(),
      due_date: unixSeconds.nullable(),
      days_until_due: z.number().int().nullable(),
      period_start: unixSeconds,
      period_end: unixSeconds,
      payment_intent: expandable(
        'payment_intent',
        '`pi_…`, or the PaymentIntent with `expand[]=payment_intent`.',
      ).nullable(),
      default_payment_method: expandable(
        'payment_method',
        '`pm_…`, or the PaymentMethod with `expand[]=default_payment_method`.',
      ).nullable(),
      automatic_tax: z
        .object({
          enabled: z.boolean(),
          status: z.enum(AUTOMATIC_TAX_STATUSES).nullable(),
          tax_calculation: z
            .string()
            .nullable()
            .describe('The Peable Tax calculation (`taxcalc_…`) the invoice finalized with.'),
        })
        .strict(),
      hosted_invoice_url: z
        .string()
        .nullable()
        .describe('The payer-facing page (anonymous, an unguessable token); `null` while a draft.'),
      invoice_pdf: z.string().nullable().describe('The PDF of the same; `null` while a draft.'),
      accepted_finalization_revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .optional()
        .describe(
          'Only returned by retrieve with include_finalization_revision=true. The exact revision accepted and stored atomically with finalization; null before finalization or when finalized without a revision. This immutable receipt supports recovery after a lost finalize response; amount equality alone is not proof.',
        ),
      finalization_revision: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable()
        .optional()
        .describe(
          'Only returned by retrieve with include_finalization_revision=true. A versioned snapshot of the inputs that finalization will consume; null after finalization. Pass it as expected_finalization_revision to refuse changes before financial effects.',
        ),
      last_finalization_error: z
        .object({ code: z.string(), message: z.string() })
        .strict()
        .nullable(),
      status_transitions: z
        .object({
          finalized_at: unixSeconds.nullable(),
          paid_at: unixSeconds.nullable(),
          voided_at: unixSeconds.nullable(),
          marked_uncollectible_at: unixSeconds.nullable(),
        })
        .strict(),
      paid_out_of_band: z.boolean(),
      test_clock: z.string().nullable(),
      metadata,
      created: unixSeconds,
      effective_at: unixSeconds.nullable(),
    })
    .strict(),
  {
    examples: [
      {
        id: 'in_0193b8f2c1a87d3e9f4a',
        object: 'invoice',
        livemode: false,
        number: 'ACME-0001',
        customer: 'cus_0193b8f2c1a87d3e9f4a',
        customer_email: 'jenny@example.com',
        customer_name: 'Jenny Rosen',
        subscription: 'sub_0193b8f2c1a87d3e9f4a',
        status: 'paid',
        billing_reason: 'subscription_create',
        collection_method: 'charge_automatically',
        currency: 'EUR',
        description: null,
        auto_advance: true,
        automatically_finalizes_at: null,
        lines: {
          object: 'list',
          data: [],
          has_more: false,
          url: '/v1/invoices/in_0193b8f2c1a87d3e9f4a/lines',
        },
        subtotal: '1999',
        subtotal_excluding_tax: '1999',
        total_discount_amounts: [],
        discount: null,
        tax: '0',
        total: '1999',
        total_excluding_tax: '1999',
        starting_balance: '0',
        ending_balance: '0',
        amount_due: '1999',
        amount_paid: '1999',
        amount_remaining: '0',
        pre_payment_credit_notes_amount: '0',
        post_payment_credit_notes_amount: '0',
        attempt_count: 1,
        attempted: true,
        next_payment_attempt: null,
        due_date: null,
        days_until_due: null,
        period_start: 1793750400,
        period_end: 1793750400,
        payment_intent: 'pi_0193b8f2c1a87d3e9f4a',
        default_payment_method: null,
        automatic_tax: { enabled: false, status: null, tax_calculation: null },
        hosted_invoice_url: 'https://checkout.peable.to/invoice/inv_tok_…',
        invoice_pdf: 'https://api.peable.to/v1/invoices/public/inv_tok_…/pdf',
        last_finalization_error: null,
        status_transitions: {
          finalized_at: 1793750400,
          paid_at: 1793750401,
          voided_at: null,
          marked_uncollectible_at: null,
        },
        paid_out_of_band: false,
        test_clock: null,
        metadata: {},
        created: 1793750400,
        effective_at: 1793750400,
      },
    ],
  },
);
export type Invoice = Expand<z.output<typeof invoiceSchema>>;

/** What `DELETE /v1/invoices/:id` (a draft) answers. */
export const deletedInvoiceSchema = defineComponent('DeletedInvoice', deletedOf('invoice'));
export type DeletedInvoice = z.output<typeof deletedInvoiceSchema>;

declare module '../../common/objects' {
  interface ObjectMap {
    invoice: Invoice;
    line_item: InvoiceLineItem;
  }
}

// ---- Requests ------------------------------------------------------------------------

export const createInvoiceParams = z
  .object({
    customer: idParam,
    currency: currencyParam
      .optional()
      .describe("Default: the subscription's, else the customer's billing currency."),
    subscription: idParam.optional(),
    auto_advance: z.boolean().optional(),
    collection_method: z.enum(COLLECTION_METHODS).optional(),
    days_until_due: daysUntilDueParam.optional(),
    due_date: unixSecondsParam.optional().describe('`send_invoice` only.'),
    description: shortText(1500).optional(),
    default_payment_method: idParam.optional(),
    discounts: discountsParam.optional(),
    automatic_tax: automaticTaxParam.optional(),
    pending_invoice_items_behavior: z
      .enum(PENDING_INVOICE_ITEMS_BEHAVIORS)
      .optional()
      .describe("Pull the customer's pending invoice items in. Default `exclude` (Stripe's)."),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateInvoiceParams = z.input<typeof createInvoiceParams>;

/** Drafts only, except `metadata` and `auto_advance`. A field sent as `""` is cleared. */
export const updateInvoiceParams = z
  .object({
    auto_advance: z.boolean().optional(),
    collection_method: z.enum(COLLECTION_METHODS).optional(),
    days_until_due: daysUntilDueParam.optional(),
    due_date: unixSecondsParam.optional(),
    description: z.union([shortText(1500), z.literal('')]).optional(),
    default_payment_method: z.union([idParam, z.literal('')]).optional(),
    discounts: z.union([discountsParam, z.literal('')]).optional(),
    automatic_tax: automaticTaxParam.optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateInvoiceParams = z.input<typeof updateInvoiceParams>;

export const retrieveInvoiceQuery = expandOnlyQuery.extend({
  include_finalization_revision: queryBoolean
    .optional()
    .describe(
      'Include an opaque approval revision captured consistently with this invoice; omitted by default.',
    ),
});

export const finalizeInvoiceParams = z
  .object({
    auto_advance: z.boolean().optional(),
    expected_finalization_revision: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe(
        'The revision returned by opt-in retrieve. Changed inputs return 409 invoice_finalization_conflict before financial effects; review again instead of retrying this approval. auto_advance must match the reviewed draft.',
      ),
    expand: expandParam.optional(),
  })
  .strict();
export type FinalizeInvoiceParams = z.input<typeof finalizeInvoiceParams>;

export const payInvoiceParams = z
  .object({
    payment_method: idParam
      .optional()
      .describe(
        "A saved `pm_…` of the customer; defaults to the invoice's, then the subscription's, then the customer's.",
      ),
    paid_out_of_band: z.boolean().optional().describe('Record a payment made outside Orbit.'),
    off_session: z.boolean().optional().describe('Default true: the customer is not present.'),
    expand: expandParam.optional(),
  })
  .strict();
export type PayInvoiceParams = z.input<typeof payInvoiceParams>;

/** The body of an invoice action that takes nothing but `expand[]` (send, void, mark uncollectible). */
export const invoiceActionParams = z.object({ expand: expandParam.optional() }).strict();
export type InvoiceActionParams = z.input<typeof invoiceActionParams>;

export const listInvoicesQuery = listQuery({
  customer: idParam.optional(),
  subscription: idParam.optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  collection_method: z.enum(COLLECTION_METHODS).optional(),
  due_date: rangeParam.optional(),
});
export type InvoiceListParams = z.input<typeof listInvoicesQuery>;

/** `GET /v1/invoices/upcoming` — a preview, never stored. */
export const upcomingInvoiceQuery = z
  .object({
    customer: idParam,
    subscription: idParam
      .optional()
      .describe("Default: the customer's most recent subscription that will renew."),
    subscription_items: z
      .array(
        z
          .object({
            id: idParam.optional(),
            price: idParam.optional(),
            quantity: queryInteger({ min: 0 }).optional(),
            deleted: queryBoolean.optional(),
          })
          .strict(),
      )
      .max(20)
      .optional()
      .describe('Preview a change: the items it would have (`subscription_items[0][price]=…`).'),
    subscription_proration_behavior: z.enum(PRORATION_BEHAVIORS).optional(),
    subscription_proration_date: queryUnixSeconds.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpcomingInvoiceParams = z.input<typeof upcomingInvoiceQuery>;

// ---- Routes --------------------------------------------------------------------------

const invoiceId = { id: 'The invoice (`in_…`).' } as const;

export const invoiceRoutes = [
  defineRoute({
    operationId: 'createInvoice',
    method: 'post',
    path: '/v1/invoices',
    tag: 'Invoices',
    summary: 'Create an invoice',
    description: 'A draft, for a customer; it finalizes on its own when `auto_advance` is set.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createInvoiceParams,
    response: invoiceSchema,
    sdk: 'invoices.create',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'listInvoices',
    method: 'get',
    path: '/v1/invoices',
    tag: 'Invoices',
    summary: 'List invoices',
    auth: 'service',
    scope: 'payments:read',
    query: listInvoicesQuery,
    response: listOf(invoiceSchema),
    sdk: 'invoices.list',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'retrieveUpcomingInvoice',
    method: 'get',
    path: '/v1/invoices/upcoming',
    tag: 'Invoices',
    summary: 'Preview the upcoming invoice',
    description:
      "The invoice a customer's subscription will renew with — or, with `subscription_items`, the one a change would produce. Computed, never stored (its `id` is empty). 404 when the customer has no subscription that will renew.",
    auth: 'service',
    scope: 'payments:read',
    query: upcomingInvoiceQuery,
    response: invoiceSchema,
    sdk: 'invoices.retrieveUpcoming',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'retrieveInvoice',
    method: 'get',
    path: '/v1/invoices/{id}',
    tag: 'Invoices',
    summary: 'Retrieve an invoice',
    auth: 'service',
    scope: 'payments:read',
    params: invoiceId,
    query: retrieveInvoiceQuery,
    response: invoiceSchema,
    sdk: 'invoices.retrieve',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'updateInvoice',
    method: 'post',
    path: '/v1/invoices/{id}',
    tag: 'Invoices',
    summary: 'Update an invoice',
    description:
      'Drafts only, except `metadata` and `auto_advance`. A field sent as `""` is cleared; `metadata` is a patch.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: invoiceId,
    body: updateInvoiceParams,
    response: invoiceSchema,
    sdk: 'invoices.update',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'deleteInvoice',
    method: 'delete',
    path: '/v1/invoices/{id}',
    tag: 'Invoices',
    summary: 'Delete a draft invoice',
    description: 'Only a draft can be deleted; a finalized invoice is voided instead.',
    auth: 'service',
    scope: 'payments:write',
    params: invoiceId,
    response: deletedInvoiceSchema,
    sdk: 'invoices.del',
  }),
  defineRoute({
    operationId: 'finalizeInvoice',
    method: 'post',
    path: '/v1/invoices/{id}/finalize',
    tag: 'Invoices',
    summary: 'Finalize a draft invoice',
    description: 'It gets its number, its tax and its payer-facing page.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: invoiceId,
    body: finalizeInvoiceParams,
    response: invoiceSchema,
    sdk: 'invoices.finalizeInvoice',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'payInvoice',
    method: 'post',
    path: '/v1/invoices/{id}/pay',
    tag: 'Invoices',
    summary: 'Pay an invoice',
    description:
      'Charge a saved card off-session, or record a payment made outside Orbit (`paid_out_of_band`). A decline is a `card_error` carrying the invoice as it now is.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: invoiceId,
    body: payInvoiceParams,
    response: invoiceSchema,
    sdk: 'invoices.pay',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'sendInvoice',
    method: 'post',
    path: '/v1/invoices/{id}/send',
    tag: 'Invoices',
    summary: 'Send an invoice to its customer',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: invoiceId,
    body: invoiceActionParams,
    response: invoiceSchema,
    sdk: 'invoices.sendInvoice',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'voidInvoice',
    method: 'post',
    path: '/v1/invoices/{id}/void',
    tag: 'Invoices',
    summary: 'Void an invoice',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: invoiceId,
    body: invoiceActionParams,
    response: invoiceSchema,
    sdk: 'invoices.voidInvoice',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'markInvoiceUncollectible',
    method: 'post',
    path: '/v1/invoices/{id}/mark_uncollectible',
    tag: 'Invoices',
    summary: 'Mark an invoice uncollectible',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: invoiceId,
    body: invoiceActionParams,
    response: invoiceSchema,
    sdk: 'invoices.markUncollectible',
    expandable: 'invoice',
  }),
  defineRoute({
    operationId: 'listInvoiceLineItems',
    method: 'get',
    path: '/v1/invoices/{id}/lines',
    tag: 'Invoices',
    summary: "List an invoice's lines",
    description: 'Every line, on one page.',
    auth: 'service',
    scope: 'payments:read',
    params: invoiceId,
    response: listOf(invoiceLineItemSchema),
    sdk: 'invoices.listLineItems',
  }),
  defineRoute({
    operationId: 'retrieveInvoicePdf',
    method: 'get',
    path: '/v1/invoices/{id}/pdf',
    tag: 'Invoices',
    summary: "Download an invoice's PDF",
    auth: 'service',
    scope: 'payments:read',
    params: invoiceId,
    response: { kind: 'binary', contentType: 'application/pdf' },
    sdk: 'invoices.retrievePdf',
  }),
  defineRoute({
    operationId: 'searchInvoices',
    method: 'get',
    path: '/v1/invoices/search',
    tag: 'Invoices',
    summary: 'Search invoices',
    description: "Stripe's query language over the invoice's fields and `metadata['key']`.",
    auth: 'service',
    scope: 'payments:read',
    query: searchQuery,
    response: searchResultOf(invoiceSchema),
    sdk: 'invoices.search',
    expandable: 'invoice',
  }),
] as const;
