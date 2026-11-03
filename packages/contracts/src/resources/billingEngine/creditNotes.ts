import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  queryInteger,
} from '../../common/params';
import { amount, currency, livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  CREDIT_NOTE_LINE_TYPES,
  CREDIT_NOTE_REASONS,
  CREDIT_NOTE_STATUSES,
  CREDIT_NOTE_TYPES,
} from '../../vocabulary/invoices';
import { invoiceActionParams } from './invoices';
import { amountParam, quantityParam, shortText } from './params';

/**
 * Credit notes (`cn_…`, ADR 0018 §4): a finalized invoice credited — on an
 * `open` one it reduces what is due; on a `paid` one it is given back
 * (refunded through the invoice's payment, credited to the customer balance,
 * or recorded as returned outside Orbit).
 */

export const creditNoteLineItemSchema = defineComponent(
  'CreditNoteLineItem',
  z
    .object({
      id: z.string(),
      object: z.literal('credit_note_line_item'),
      type: z.enum(CREDIT_NOTE_LINE_TYPES),
      invoice_line_item: z.string().nullable().describe('The invoice line (`il_…`) it credits.'),
      description: z.string().nullable(),
      quantity: z.number().int().nullable(),
      amount: amount.describe('Before tax; tax-inclusive when the invoice line is.'),
      tax_amount: amount,
    })
    .strict(),
);
export type CreditNoteLineItem = z.output<typeof creditNoteLineItemSchema>;

export const creditNoteSchema = defineObject(
  'credit_note',
  'CreditNote',
  z
    .object({
      id: z.string(),
      object: z.literal('credit_note'),
      livemode,
      number: z.string().describe('`<invoice number>-CN-<nn>`.'),
      invoice: expandable('invoice', '`in_…`, or the Invoice with `expand[]=invoice`.'),
      customer: expandable('customer', '`cus_…`, or the Customer with `expand[]=customer`.'),
      status: z.enum(CREDIT_NOTE_STATUSES),
      type: z.enum(CREDIT_NOTE_TYPES),
      reason: z.enum(CREDIT_NOTE_REASONS).nullable(),
      currency,
      lines: listOf(creditNoteLineItemSchema),
      subtotal: amount,
      tax: amount,
      total: amount.describe('What is credited, tax included.'),
      refund_amount: amount.describe("Of `total`: refunded through the invoice's payment."),
      credit_amount: amount.describe('Of `total`: credited to the customer balance.'),
      out_of_band_amount: amount.describe('Of `total`: recorded as returned outside Orbit.'),
      refund: z.string().nullable().describe('The Refund (`re_…`) when part of it was refunded.'),
      customer_balance_transaction: z
        .string()
        .nullable()
        .describe('The customer balance transaction (`cbtxn_…`) of `credit_amount`.'),
      memo: z.string().nullable(),
      metadata,
      voided_at: unixSeconds.nullable(),
      created: unixSeconds,
    })
    .strict(),
);
export type CreditNote = Expand<z.output<typeof creditNoteSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    credit_note: CreditNote;
  }
}

const creditNoteFields = {
  invoice: idParam,
  amount: amountParam
    .optional()
    .describe('Credit this much of the invoice, tax included, spread over its lines.'),
  reason: z.enum(CREDIT_NOTE_REASONS).optional(),
  memo: shortText(5000).optional(),
  refund_amount: amountParam.optional(),
  credit_amount: amountParam.optional(),
  out_of_band_amount: amountParam.optional(),
};

const creditNoteLineFields = {
  type: z.enum(CREDIT_NOTE_LINE_TYPES),
  invoice_line_item: idParam.optional(),
  amount: amountParam
    .optional()
    .describe('For an invoice line: the amount of it to credit (default all of it).'),
  description: shortText(500).optional(),
};

/**
 * Credit `lines`, or a whole `amount` (custom).
 *
 * On a `paid` invoice the credit must be distributed: `refund_amount` (through
 * the invoice's payment; card only), `credit_amount` (to the customer balance)
 * and `out_of_band_amount` must add up to the total. Omitted, all of it is
 * refunded on a card invoice and credited to the balance otherwise. On an
 * `open` invoice it reduces `amount_due` and none of the three apply.
 */
export const createCreditNoteParams = z
  .object({
    ...creditNoteFields,
    lines: z
      .array(z.object({ ...creditNoteLineFields, quantity: quantityParam.optional() }).strict())
      .min(1)
      .max(100)
      .optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateCreditNoteParams = z.input<typeof createCreditNoteParams>;

/** The create's fields as a query (`lines[0][type]=…`). */
export const previewCreditNoteQuery = z
  .object({
    ...creditNoteFields,
    lines: z
      .array(
        z
          .object({ ...creditNoteLineFields, quantity: queryInteger({ min: 0 }).optional() })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export type PreviewCreditNoteParams = z.input<typeof previewCreditNoteQuery>;

export const voidCreditNoteParams = invoiceActionParams;
export type VoidCreditNoteParams = z.input<typeof voidCreditNoteParams>;

export const listCreditNotesQuery = listQuery({
  invoice: idParam.optional(),
  customer: idParam.optional(),
});
export type CreditNoteListParams = z.input<typeof listCreditNotesQuery>;

const creditNoteId = { id: 'The credit note (`cn_…`).' } as const;

export const creditNoteRoutes = [
  defineRoute({
    operationId: 'createCreditNote',
    method: 'post',
    path: '/v1/credit_notes',
    tag: 'Credit notes',
    summary: 'Issue a credit note',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createCreditNoteParams,
    response: creditNoteSchema,
    sdk: 'creditNotes.create',
    expandable: 'credit_note',
  }),
  defineRoute({
    operationId: 'listCreditNotes',
    method: 'get',
    path: '/v1/credit_notes',
    tag: 'Credit notes',
    summary: 'List credit notes',
    auth: 'service',
    scope: 'payments:read',
    query: listCreditNotesQuery,
    response: listOf(creditNoteSchema),
    sdk: 'creditNotes.list',
    expandable: 'credit_note',
  }),
  defineRoute({
    operationId: 'previewCreditNote',
    method: 'get',
    path: '/v1/credit_notes/preview',
    tag: 'Credit notes',
    summary: 'Preview a credit note',
    description:
      'The note `POST /v1/credit_notes` would issue with the same fields, computed and never stored (its `id` and `number` are empty).',
    auth: 'service',
    scope: 'payments:read',
    query: previewCreditNoteQuery,
    response: creditNoteSchema,
    sdk: 'creditNotes.preview',
  }),
  defineRoute({
    operationId: 'retrieveCreditNote',
    method: 'get',
    path: '/v1/credit_notes/{id}',
    tag: 'Credit notes',
    summary: 'Retrieve a credit note',
    auth: 'service',
    scope: 'payments:read',
    params: creditNoteId,
    query: expandOnlyQuery,
    response: creditNoteSchema,
    sdk: 'creditNotes.retrieve',
    expandable: 'credit_note',
  }),
  defineRoute({
    operationId: 'voidCreditNote',
    method: 'post',
    path: '/v1/credit_notes/{id}/void',
    tag: 'Credit notes',
    summary: 'Void a credit note',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: creditNoteId,
    body: voidCreditNoteParams,
    response: creditNoteSchema,
    sdk: 'creditNotes.voidCreditNote',
    expandable: 'credit_note',
  }),
] as const;
