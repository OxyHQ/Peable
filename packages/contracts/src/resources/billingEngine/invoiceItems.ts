import { z } from 'zod';
import { deletedOf, listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  queryBoolean,
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
import { amountParam, currencyParam, embedded, quantityParam, shortText } from './params';

/**
 * Invoice items (`ii_…`, ADR 0018 §2): a charge waiting for an invoice — a
 * pending item is pulled into the customer's next invoice (a subscription's
 * renewal, or a manual invoice with `pending_invoice_items_behavior=include`),
 * or it is created directly on a draft.
 */
export const invoiceItemSchema = defineObject(
  'invoiceitem',
  'InvoiceItem',
  z
    .object({
      id: z.string(),
      object: z.literal('invoiceitem'),
      livemode,
      customer: expandable('customer', '`cus_…`, or the Customer with `expand[]=customer`.'),
      invoice: expandable(
        'invoice',
        'The draft it is on (`in_…`, or the Invoice with `expand[]=invoice`); `null` while pending.',
      ).nullable(),
      subscription: expandable(
        'subscription',
        '`sub_…`, or the Subscription with `expand[]=subscription`.',
      ).nullable(),
      subscription_item: z.string().nullable(),
      price: embedded('price', 'The Price, embedded; `null` for a fixed amount.').nullable(),
      quantity: z.number().int().nonnegative(),
      unit_amount: amount
        .nullable()
        .describe(
          'Base units per unit; `null` for a proration (an amount for a period, not per unit).',
        ),
      amount: signedAmount.describe('SIGNED (an engine-made proration credit is negative).'),
      currency,
      description: z.string().nullable(),
      discountable: z.boolean(),
      period: z.object({ start: unixSeconds, end: unixSeconds }).strict(),
      proration: z.boolean(),
      metadata,
      date: unixSeconds,
    })
    .strict(),
);
export type InvoiceItem = Expand<z.output<typeof invoiceItemSchema>>;

export const deletedInvoiceItemSchema = defineComponent(
  'DeletedInvoiceItem',
  deletedOf('invoiceitem'),
);
export type DeletedInvoiceItem = z.output<typeof deletedInvoiceItemSchema>;

declare module '../../common/objects' {
  interface ObjectMap {
    invoiceitem: InvoiceItem;
  }
}

/**
 * Inline `price_data` (Stripe's): a one-off per-unit price of an existing
 * product, for an item that names no stored price. Never stored as a
 * `price_…` by itself. The shape is checked here; the catalog's rules (the
 * per-currency bound of `unit_amount`, the three-year interval) are applied
 * by the gateway when it prices the item.
 */
export const invoiceItemPriceDataParams = z
  .object({
    product: z.string().min(1).max(255),
    currency: currencyParam,
    unit_amount: amountParam,
    recurring: z
      .object({
        interval: z.enum(['day', 'week', 'month', 'year']),
        interval_count: z.number().int().min(1).max(2_147_483_647).optional(),
      })
      .strict()
      .optional(),
    tax_behavior: z.enum(['inclusive', 'exclusive', 'unspecified']).optional(),
  })
  .strict();
export type InvoiceItemPriceDataParams = z.input<typeof invoiceItemPriceDataParams>;

/**
 * A price (`price` or `price_data`) times `quantity`, or a fixed `amount` +
 * `currency`. Never negative — a credit is a credit note or a customer balance
 * transaction.
 */
export const createInvoiceItemParams = z
  .object({
    customer: idParam,
    invoice: idParam.optional().describe('A draft to put it on; absent, it is pending.'),
    subscription: idParam.optional(),
    price: idParam.optional(),
    price_data: invoiceItemPriceDataParams.optional(),
    quantity: quantityParam.optional(),
    amount: amountParam.optional(),
    currency: currencyParam.optional(),
    description: shortText(500).optional(),
    discountable: z.boolean().optional(),
    period: z.object({ start: unixSecondsParam, end: unixSecondsParam }).strict().optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateInvoiceItemParams = z.input<typeof createInvoiceItemParams>;

/** Pending items, or items on a draft. A field sent as `""` is cleared; `metadata` is a patch. */
export const updateInvoiceItemParams = z
  .object({
    description: z.union([shortText(500), z.literal('')]).optional(),
    quantity: quantityParam.optional(),
    discountable: z.boolean().optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateInvoiceItemParams = z.input<typeof updateInvoiceItemParams>;

export const listInvoiceItemsQuery = listQuery({
  customer: idParam.optional(),
  invoice: idParam.optional(),
  pending: queryBoolean.optional().describe('Only items not on any invoice yet.'),
});
export type InvoiceItemListParams = z.input<typeof listInvoiceItemsQuery>;

const invoiceItemId = { id: 'The invoice item (`ii_…`).' } as const;

export const invoiceItemRoutes = [
  defineRoute({
    operationId: 'createInvoiceItem',
    method: 'post',
    path: '/v1/invoiceitems',
    tag: 'Invoice items',
    summary: 'Create an invoice item',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createInvoiceItemParams,
    response: invoiceItemSchema,
    sdk: 'invoiceItems.create',
    expandable: 'invoiceitem',
  }),
  defineRoute({
    operationId: 'listInvoiceItems',
    method: 'get',
    path: '/v1/invoiceitems',
    tag: 'Invoice items',
    summary: 'List invoice items',
    auth: 'service',
    scope: 'payments:read',
    query: listInvoiceItemsQuery,
    response: listOf(invoiceItemSchema),
    sdk: 'invoiceItems.list',
    expandable: 'invoiceitem',
  }),
  defineRoute({
    operationId: 'retrieveInvoiceItem',
    method: 'get',
    path: '/v1/invoiceitems/{id}',
    tag: 'Invoice items',
    summary: 'Retrieve an invoice item',
    auth: 'service',
    scope: 'payments:read',
    params: invoiceItemId,
    query: expandOnlyQuery,
    response: invoiceItemSchema,
    sdk: 'invoiceItems.retrieve',
    expandable: 'invoiceitem',
  }),
  defineRoute({
    operationId: 'updateInvoiceItem',
    method: 'post',
    path: '/v1/invoiceitems/{id}',
    tag: 'Invoice items',
    summary: 'Update an invoice item',
    description: 'While it is pending or on a draft.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: invoiceItemId,
    body: updateInvoiceItemParams,
    response: invoiceItemSchema,
    sdk: 'invoiceItems.update',
    expandable: 'invoiceitem',
  }),
  defineRoute({
    operationId: 'deleteInvoiceItem',
    method: 'delete',
    path: '/v1/invoiceitems/{id}',
    tag: 'Invoice items',
    summary: 'Delete an invoice item',
    description: 'While it is pending or on a draft.',
    auth: 'service',
    scope: 'payments:write',
    params: invoiceItemId,
    response: deletedInvoiceItemSchema,
    sdk: 'invoiceItems.del',
  }),
] as const;
