/**
 * Invoices (`in_…`), invoice items (`ii_…`), credit notes (`cn_…`) and the
 * customer balance ledger — ADR 0018 §2–4.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  COLLECTION_METHODS,
  CREDIT_NOTE_REASONS,
  INVOICE_STATUSES,
  PRORATION_BEHAVIORS,
} from '@peable.to/shared-types';
import {
  findCustomerForMerchant,
  findLiveCustomerForMerchant,
} from '../../db/customers/customerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  findBalanceTransaction,
  listBalanceTransactions,
} from '../../db/billingEngine/balanceRepository';
import {
  findCreditNoteForMerchant,
  listCreditNotes,
} from '../../db/billingEngine/creditNoteRepository';
import {
  findInvoiceForMerchant,
  findInvoiceItemForMerchant,
  listInvoiceItems,
  listInvoices,
  listLines,
} from '../../db/billingEngine/invoiceRepository';
import {
  findSubscriptionForMerchant,
  listCustomerSubscriptions,
} from '../../db/billingEngine/subscriptionRepository';
import { getDb } from '../../db/postgres';
import { priceDataSchema, currencySchema, amountSchema } from '../../services/catalog/params';
import {
  answerList,
  expandParam,
  parseQuery,
  type QuerySurface,
  resolveListReference,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../../lib/list';
import { metadataCreateSchema, metadataUpdateSchema } from '../../lib/metadata';
import {
  renderInvoice,
  renderInvoiceItems,
  renderInvoices,
  toBalanceTransactionDTO,
  toInvoiceLineDTO,
} from '../../lib/serializeBilling';
import { toPriceDTO } from '../../lib/serializeCatalog';
import { findPricesByRowIds } from '../../db/catalog/priceRepository';
import {
  createCreditNote,
  previewCreditNote,
  renderCreditNotes,
  voidCreditNote,
} from '../../services/billingEngine/creditNotes';
import { BillingEngineError, missing } from '../../services/billingEngine/errors';
import {
  adjustCustomerBalance,
  createInvoice,
  createInvoiceItem,
  deleteDraftInvoice,
  deletePendingInvoiceItem,
  finalizeInvoice,
  markInvoiceUncollectible,
  payInvoice,
  sendInvoice,
  updateInvoice,
  updateInvoiceItem,
  voidInvoice,
} from '../../services/billingEngine/invoices';
import { upcomingInvoice } from '../../services/billingEngine/upcoming';
import { invoicePdf } from '../../services/billingEngine/invoicePdf';
import type { CatalogRoute } from '../catalogRoutes';
import {
  answerObject,
  cleared,
  idParam,
  idString,
  parseBody,
  quantity,
  queryUnixSeconds,
  rangeQuery,
  shortText,
  signedAmount,
  unixSeconds,
} from './helpers';

const discountsSchema = z
  .array(z.object({ coupon: idString.optional(), promotion_code: idString.optional() }).strict())
  .max(20);

const createBody = z
  .object({
    customer: idString,
    currency: currencySchema.optional(),
    subscription: idString.optional(),
    auto_advance: z.boolean().optional(),
    collection_method: z.enum(COLLECTION_METHODS).optional(),
    days_until_due: z.number().int().min(0).max(365).optional(),
    due_date: unixSeconds.optional(),
    description: shortText(1500).optional(),
    default_payment_method: idString.optional(),
    discounts: discountsSchema.optional(),
    automatic_tax: z.object({ enabled: z.boolean() }).strict().optional(),
    pending_invoice_items_behavior: z.enum(['include', 'exclude']).optional(),
    metadata: metadataCreateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();

const updateBody = z
  .object({
    auto_advance: z.boolean().optional(),
    collection_method: z.enum(COLLECTION_METHODS).optional(),
    days_until_due: z.number().int().min(0).max(365).optional(),
    due_date: unixSeconds.optional(),
    description: z.union([shortText(1500), z.literal('')]).optional(),
    default_payment_method: z.union([idString, z.literal('')]).optional(),
    discounts: z.union([discountsSchema, z.literal('')]).optional(),
    automatic_tax: z.object({ enabled: z.boolean() }).strict().optional(),
    metadata: metadataUpdateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();

const finalizeBody = z
  .object({ auto_advance: z.boolean().optional(), expand: expandParam.optional() })
  .strict();
const payBody = z
  .object({
    payment_method: idString.optional(),
    paid_out_of_band: z.boolean().optional(),
    off_session: z.boolean().optional(),
    expand: expandParam.optional(),
  })
  .strict();
const plainBody = z.object({ expand: expandParam.optional() }).strict();

const listQuery = surfaceListQuery({
  customer: idString.optional(),
  subscription: idString.optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  collection_method: z.enum(COLLECTION_METHODS).optional(),
  due_date: rangeQuery.optional(),
});
const retrieveQuery = surfaceRetrieveQuery();

const upcomingQuery = {
  api: z
    .object({
      customer: idString,
      subscription: idString.optional(),
      subscription_items: z
        .array(
          z
            .object({
              id: idString.optional(),
              price: idString.optional(),
              quantity: z.coerce.number().int().min(0).optional(),
              deleted: z
                .enum(['true', 'false'])
                .transform((v) => v === 'true')
                .optional(),
            })
            .strict(),
        )
        .max(20)
        .optional(),
      subscription_proration_behavior: z.enum(PRORATION_BEHAVIORS).optional(),
      subscription_proration_date: queryUnixSeconds.optional(),
      expand: expandParam.optional(),
    })
    .strict(),
};
const upcomingSurface = {
  api: upcomingQuery.api,
  dashboard: upcomingQuery.api.extend({
    environment: z.enum(['development', 'staging', 'production']),
  }),
} as const;

async function answer(
  res: Response,
  merchant: MerchantRow,
  publicId: string,
  expand: readonly string[] | undefined,
) {
  const db = getDb();
  const row = await findInvoiceForMerchant(db, publicId, merchant.id);
  if (!row) throw missing('invoice');
  await answerObject(res, merchant, 'invoice', await renderInvoice(db, row), expand);
}

async function create(req: Request, res: Response, merchant: MerchantRow) {
  const body = parseBody(req, res, createBody);
  if (!body) return;
  const row = await createInvoice(merchant, {
    customer: body.customer,
    ...(body.currency ? { currency: body.currency } : {}),
    ...(body.subscription ? { subscription: body.subscription } : {}),
    ...(body.auto_advance !== undefined ? { autoAdvance: body.auto_advance } : {}),
    ...(body.collection_method ? { collectionMethod: body.collection_method } : {}),
    ...(body.days_until_due !== undefined ? { daysUntilDue: body.days_until_due } : {}),
    ...(body.due_date !== undefined ? { dueDate: body.due_date } : {}),
    ...(body.description ? { description: body.description } : {}),
    ...(body.default_payment_method ? { defaultPaymentMethod: body.default_payment_method } : {}),
    ...(body.discounts ? { discounts: body.discounts } : {}),
    ...(body.automatic_tax ? { automaticTax: body.automatic_tax.enabled } : {}),
    ...(body.pending_invoice_items_behavior
      ? { pendingInvoiceItemsBehavior: body.pending_invoice_items_behavior }
      : {}),
    metadata: body.metadata ?? {},
  });
  await answer(res, merchant, row.publicId, body.expand);
}

async function retrieve(req: Request, res: Response, merchant: MerchantRow, surface: QuerySurface) {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  await answer(res, merchant, id, query.expand);
}

async function update(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, updateBody);
  if (!body) return;
  const row = await updateInvoice(merchant, id, {
    ...(body.auto_advance !== undefined ? { autoAdvance: body.auto_advance } : {}),
    ...(body.collection_method ? { collectionMethod: body.collection_method } : {}),
    ...(body.days_until_due !== undefined ? { daysUntilDue: body.days_until_due } : {}),
    ...(body.due_date !== undefined ? { dueDate: body.due_date } : {}),
    ...(body.description !== undefined ? { description: cleared(body.description) ?? null } : {}),
    ...(body.default_payment_method !== undefined
      ? { defaultPaymentMethod: cleared(body.default_payment_method) ?? null }
      : {}),
    ...(body.discounts !== undefined ? { discounts: cleared(body.discounts) ?? null } : {}),
    ...(body.automatic_tax ? { automaticTax: body.automatic_tax.enabled } : {}),
    ...(body.metadata ? { metadata: body.metadata } : {}),
  });
  await answer(res, merchant, row.publicId, body.expand);
}

function action(
  run: (
    merchant: MerchantRow,
    id: string,
    body: z.infer<typeof payBody> & z.infer<typeof finalizeBody>,
  ) => Promise<{ publicId: string }>,
  schema: z.ZodTypeAny,
) {
  return async (req: Request, res: Response, merchant: MerchantRow) => {
    const id = idParam(req, res);
    if (!id) return;
    const body = parseBody(req, res, schema);
    if (!body) return;
    const row = await run(merchant, id, body as z.infer<typeof payBody>);
    await answer(res, merchant, row.publicId, (body as { expand?: string[] }).expand);
  };
}

async function remove(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const row = await deleteDraftInvoice(merchant, id);
  res.status(200).json({ id: row.publicId, object: 'invoice', deleted: true });
}

async function list(req: Request, res: Response, merchant: MerchantRow, surface: QuerySurface) {
  const query = parseQuery(req, res, listQuery[surface]);
  if (!query) return;
  const db = getDb();
  const customer = await resolveListReference(
    res,
    'customer',
    query.customer,
    async (id) => (await findCustomerForMerchant(db, id, merchant.id))?.id ?? null,
  );
  if (!customer.ok) return;
  const subscription = await resolveListReference(
    res,
    'subscription',
    query.subscription,
    async (id) => (await findSubscriptionForMerchant(db, id, merchant.id))?.id ?? null,
  );
  if (!subscription.ok) return;
  await answerList(req, res, {
    query,
    type: 'invoice',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findInvoiceForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listInvoices(db, {
        merchantId: merchant.id,
        page,
        customerId: customer.id,
        subscriptionId: subscription.id,
        status: query.status,
        collectionMethod: query.collection_method,
        dueDate: query.due_date,
      }),
    serializeAll: (rows) => renderInvoices(db, rows),
  });
}

async function lines(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const db = getDb();
  const invoice = await findInvoiceForMerchant(db, id, merchant.id);
  if (!invoice) throw missing('invoice');
  const rows = await listLines(db, invoice.id);
  const prices = await findPricesByRowIds(
    db,
    rows.map((row) => row.priceId).filter((p): p is string => p !== null),
  );
  res.status(200).json({
    object: 'list',
    data: rows.map((row) => {
      const price = prices.find((candidate) => candidate.id === row.priceId);
      return toInvoiceLineDTO(row, price ? toPriceDTO(price) : null);
    }),
    has_more: false,
    url: req.originalUrl.split('?')[0],
  });
}

async function upcoming(req: Request, res: Response, merchant: MerchantRow, surface: QuerySurface) {
  const query = parseQuery(req, res, upcomingSurface[surface]);
  if (!query) return;
  const db = getDb();
  const customer = await findLiveCustomerForMerchant(db, query.customer, merchant.id);
  if (!customer)
    throw new BillingEngineError(
      'resource_missing',
      `no such customer: '${query.customer}'`,
      'customer',
    );
  let subscription = query.subscription
    ? await findSubscriptionForMerchant(db, query.subscription, merchant.id)
    : null;
  if (query.subscription && (!subscription || subscription.customerId !== customer.id)) {
    throw new BillingEngineError(
      'resource_missing',
      `no such subscription of this customer: '${query.subscription}'`,
      'subscription',
    );
  }
  if (!subscription) {
    subscription =
      (
        await listCustomerSubscriptions(db, customer.id, [
          'trialing',
          'active',
          'past_due',
          'unpaid',
        ])
      ).at(-1) ?? null;
  }
  const preview = subscription
    ? await upcomingInvoice(db, subscription, {
        ...(query.subscription_items
          ? {
              items: query.subscription_items.map((item) => ({
                ...(item.id ? { id: item.id } : {}),
                ...(item.price ? { price: item.price } : {}),
                ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
                ...(item.deleted ? { deleted: true } : {}),
              })),
            }
          : {}),
        ...(query.subscription_proration_behavior
          ? { prorationBehavior: query.subscription_proration_behavior }
          : {}),
        ...(query.subscription_proration_date !== undefined
          ? { prorationDate: new Date(query.subscription_proration_date * 1000) }
          : {}),
      })
    : null;
  if (!preview) {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      'no upcoming invoice: the customer has no subscription that will renew',
      undefined,
      404,
    );
  }
  await answerObject(res, merchant, 'invoice', preview, query.expand);
}

async function pdf(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const invoice = await findInvoiceForMerchant(getDb(), id, merchant.id);
  if (!invoice) throw missing('invoice');
  const document = await invoicePdf(invoice);
  res
    .status(200)
    .type('application/pdf')
    .setHeader(
      'Content-Disposition',
      `inline; filename="${invoice.number ?? invoice.publicId}.pdf"`,
    );
  res.end(Buffer.from(document));
}

// ---- Invoice items --------------------------------------------------------------------

const createItemBody = z
  .object({
    customer: idString,
    invoice: idString.optional(),
    subscription: idString.optional(),
    price: idString.optional(),
    price_data: priceDataSchema.optional(),
    quantity: quantity.optional(),
    amount: amountSchema.optional(),
    currency: currencySchema.optional(),
    description: shortText(500).optional(),
    discountable: z.boolean().optional(),
    period: z.object({ start: unixSeconds, end: unixSeconds }).strict().optional(),
    metadata: metadataCreateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();

const updateItemBody = z
  .object({
    description: z.union([shortText(500), z.literal('')]).optional(),
    quantity: quantity.optional(),
    discountable: z.boolean().optional(),
    metadata: metadataUpdateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();

const listItemsQuery = surfaceListQuery({
  customer: idString.optional(),
  invoice: idString.optional(),
  pending: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

async function answerItem(
  res: Response,
  merchant: MerchantRow,
  publicId: string,
  expand: readonly string[] | undefined,
) {
  const db = getDb();
  const row = await findInvoiceItemForMerchant(db, publicId, merchant.id);
  if (!row) throw missing('invoice item');
  const [dto] = await renderInvoiceItems(db, [row]);
  if (!dto) throw new Error('invoice item did not render');
  await answerObject(res, merchant, 'invoiceitem', dto, expand);
}

async function createItem(req: Request, res: Response, merchant: MerchantRow) {
  const body = parseBody(req, res, createItemBody);
  if (!body) return;
  const row = await createInvoiceItem(merchant, {
    customer: body.customer,
    ...(body.invoice ? { invoice: body.invoice } : {}),
    ...(body.subscription ? { subscription: body.subscription } : {}),
    ...(body.price ? { price: body.price } : {}),
    ...(body.price_data ? { priceData: body.price_data } : {}),
    ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
    ...(body.amount !== undefined ? { amount: body.amount } : {}),
    ...(body.currency ? { currency: body.currency } : {}),
    ...(body.description ? { description: body.description } : {}),
    ...(body.discountable !== undefined ? { discountable: body.discountable } : {}),
    ...(body.period ? { period: body.period } : {}),
    metadata: body.metadata ?? {},
  });
  await answerItem(res, merchant, row.publicId, body.expand);
}

async function retrieveItem(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  await answerItem(res, merchant, id, query.expand);
}

async function updateItem(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, updateItemBody);
  if (!body) return;
  const row = await updateInvoiceItem(merchant, id, {
    ...(body.description !== undefined ? { description: cleared(body.description) ?? null } : {}),
    ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
    ...(body.discountable !== undefined ? { discountable: body.discountable } : {}),
    ...(body.metadata ? { metadata: body.metadata } : {}),
  });
  await answerItem(res, merchant, row.publicId, body.expand);
}

async function deleteItem(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const row = await deletePendingInvoiceItem(merchant, id);
  res.status(200).json({ id: row.publicId, object: 'invoiceitem', deleted: true });
}

async function listItems(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const query = parseQuery(req, res, listItemsQuery[surface]);
  if (!query) return;
  const db = getDb();
  const customer = await resolveListReference(
    res,
    'customer',
    query.customer,
    async (id) => (await findCustomerForMerchant(db, id, merchant.id))?.id ?? null,
  );
  if (!customer.ok) return;
  const invoice = await resolveListReference(
    res,
    'invoice',
    query.invoice,
    async (id) => (await findInvoiceForMerchant(db, id, merchant.id))?.id ?? null,
  );
  if (!invoice.ok) return;
  await answerList(req, res, {
    query,
    type: 'invoiceitem',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findInvoiceItemForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listInvoiceItems(db, {
        merchantId: merchant.id,
        page,
        customerId: customer.id,
        invoiceId: invoice.id,
        pending: query.pending,
      }),
    serializeAll: (rows) => renderInvoiceItems(db, rows),
  });
}

// ---- Credit notes ------------------------------------------------------------------------

const creditLineSchema = z
  .object({
    type: z.enum(['invoice_line_item', 'custom_line_item']),
    invoice_line_item: idString.optional(),
    amount: amountSchema.optional(),
    quantity: quantity.optional(),
    description: shortText(500).optional(),
  })
  .strict();

const creditNoteFields = {
  invoice: idString,
  lines: z.array(creditLineSchema).min(1).max(100).optional(),
  amount: amountSchema.optional(),
  reason: z.enum(CREDIT_NOTE_REASONS).optional(),
  memo: shortText(5000).optional(),
  refund_amount: amountSchema.optional(),
  credit_amount: amountSchema.optional(),
  out_of_band_amount: amountSchema.optional(),
};
const createCreditNoteBody = z
  .object({
    ...creditNoteFields,
    metadata: metadataCreateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();

function creditNoteInput(body: z.infer<typeof createCreditNoteBody>) {
  return {
    invoice: body.invoice,
    ...(body.lines
      ? {
          lines: body.lines.map((line) => ({
            type: line.type,
            ...(line.invoice_line_item ? { invoiceLineItem: line.invoice_line_item } : {}),
            ...(line.amount !== undefined ? { amount: line.amount } : {}),
            ...(line.quantity !== undefined ? { quantity: line.quantity } : {}),
            ...(line.description ? { description: line.description } : {}),
          })),
        }
      : {}),
    ...(body.amount !== undefined ? { amount: body.amount } : {}),
    ...(body.reason ? { reason: body.reason } : {}),
    ...(body.memo ? { memo: body.memo } : {}),
    ...(body.refund_amount !== undefined ? { refundAmount: body.refund_amount } : {}),
    ...(body.credit_amount !== undefined ? { creditAmount: body.credit_amount } : {}),
    ...(body.out_of_band_amount !== undefined ? { outOfBandAmount: body.out_of_band_amount } : {}),
    metadata: body.metadata ?? {},
  };
}

/** The preview takes the create's fields as a query (`lines[0][type]=…`). */
const previewQuery = (dashboard: boolean) =>
  z
    .object({
      invoice: idString,
      lines: z
        .array(
          z
            .object({
              type: z.enum(['invoice_line_item', 'custom_line_item']),
              invoice_line_item: idString.optional(),
              amount: amountSchema.optional(),
              quantity: z.coerce.number().int().min(0).optional(),
              description: shortText(500).optional(),
            })
            .strict(),
        )
        .max(100)
        .optional(),
      amount: amountSchema.optional(),
      reason: z.enum(CREDIT_NOTE_REASONS).optional(),
      memo: shortText(5000).optional(),
      refund_amount: amountSchema.optional(),
      credit_amount: amountSchema.optional(),
      out_of_band_amount: amountSchema.optional(),
      ...(dashboard ? { environment: z.enum(['development', 'staging', 'production']) } : {}),
    })
    .strict();
const previewSurface = { api: previewQuery(false), dashboard: previewQuery(true) } as const;

const listCreditNotesQuery = surfaceListQuery({
  invoice: idString.optional(),
  customer: idString.optional(),
});

async function answerCreditNote(
  res: Response,
  merchant: MerchantRow,
  publicId: string,
  expand: readonly string[] | undefined,
) {
  const db = getDb();
  const row = await findCreditNoteForMerchant(db, publicId, merchant.id);
  if (!row) throw missing('credit note');
  const [dto] = await renderCreditNotes(db, [row]);
  if (!dto) throw new Error('credit note did not render');
  await answerObject(res, merchant, 'credit_note', dto, expand);
}

async function createNote(req: Request, res: Response, merchant: MerchantRow) {
  const body = parseBody(req, res, createCreditNoteBody);
  if (!body) return;
  const row = await createCreditNote(merchant, creditNoteInput(body));
  await answerCreditNote(res, merchant, row.publicId, body.expand);
}

async function previewNote(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const query = parseQuery(req, res, previewSurface[surface]);
  if (!query) return;
  const { environment: _environment, ...fields } = query as typeof query & { environment?: string };
  res
    .status(200)
    .json(
      await previewCreditNote(
        merchant,
        creditNoteInput(fields as z.infer<typeof createCreditNoteBody>),
      ),
    );
}

async function retrieveNote(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  await answerCreditNote(res, merchant, id, query.expand);
}

async function voidNote(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, plainBody);
  if (!body) return;
  const row = await voidCreditNote(merchant, id);
  await answerCreditNote(res, merchant, row.publicId, body.expand);
}

async function listNotes(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const query = parseQuery(req, res, listCreditNotesQuery[surface]);
  if (!query) return;
  const db = getDb();
  const invoice = await resolveListReference(
    res,
    'invoice',
    query.invoice,
    async (id) => (await findInvoiceForMerchant(db, id, merchant.id))?.id ?? null,
  );
  if (!invoice.ok) return;
  const customer = await resolveListReference(
    res,
    'customer',
    query.customer,
    async (id) => (await findCustomerForMerchant(db, id, merchant.id))?.id ?? null,
  );
  if (!customer.ok) return;
  await answerList(req, res, {
    query,
    type: 'credit_note',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findCreditNoteForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listCreditNotes(db, {
        merchantId: merchant.id,
        page,
        invoiceId: invoice.id,
        customerId: customer.id,
      }),
    serializeAll: (rows) => renderCreditNotes(db, rows),
  });
}

// ---- Customer balance ---------------------------------------------------------------------

const balanceBody = z
  .object({
    amount: signedAmount,
    currency: currencySchema,
    description: shortText(350).optional(),
    metadata: metadataCreateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();
const listBalanceQuery = surfaceListQuery({});

async function customerOf(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return null;
  const customer = await findCustomerForMerchant(getDb(), id, merchant.id);
  if (!customer) throw missing('customer');
  return customer;
}

async function createBalance(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, balanceBody);
  if (!body) return;
  const row = await adjustCustomerBalance(merchant, id, {
    amount: BigInt(body.amount),
    currency: body.currency,
    ...(body.description ? { description: body.description } : {}),
    metadata: body.metadata ?? {},
  });
  await answerObject(
    res,
    merchant,
    'customer_balance_transaction',
    toBalanceTransactionDTO(row),
    body.expand,
  );
}

async function retrieveBalance(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const customer = await customerOf(req, res, merchant);
  if (!customer) return;
  const id = idParam(req, res, 'transaction');
  if (!id) return;
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  const row = await findBalanceTransaction(getDb(), id, customer.id);
  if (!row) throw missing('balance transaction');
  await answerObject(
    res,
    merchant,
    'customer_balance_transaction',
    toBalanceTransactionDTO(row),
    query.expand,
  );
}

async function listBalance(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const customer = await customerOf(req, res, merchant);
  if (!customer) return;
  const query = parseQuery(req, res, listBalanceQuery[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'customer_balance_transaction',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findBalanceTransaction(db, publicId, customer.id))?.id ?? null,
    fetch: (page) => listBalanceTransactions(db, customer.id, page),
    serialize: toBalanceTransactionDTO,
  });
}

export const INVOICE_ROUTES: readonly CatalogRoute[] = [
  { method: 'post', path: '/invoices', core: create },
  { method: 'get', path: '/invoices', core: list },
  // Before `/invoices/:id`, which would otherwise read `upcoming` as an id.
  { method: 'get', path: '/invoices/upcoming', core: upcoming },
  { method: 'get', path: '/invoices/:id', core: retrieve },
  { method: 'post', path: '/invoices/:id', core: update },
  { method: 'delete', path: '/invoices/:id', core: remove },
  {
    method: 'post',
    path: '/invoices/:id/finalize',
    core: action(
      (m, id, b) =>
        finalizeInvoice(m, id, {
          ...(b.auto_advance !== undefined ? { autoAdvance: b.auto_advance } : {}),
        }),
      finalizeBody,
    ),
  },
  {
    method: 'post',
    path: '/invoices/:id/pay',
    core: action(
      (m, id, b) =>
        payInvoice(m, id, {
          ...(b.payment_method ? { paymentMethod: b.payment_method } : {}),
          ...(b.paid_out_of_band ? { paidOutOfBand: true } : {}),
          ...(b.off_session !== undefined ? { offSession: b.off_session } : {}),
        }),
      payBody,
    ),
  },
  {
    method: 'post',
    path: '/invoices/:id/send',
    core: action((m, id) => sendInvoice(m, id), plainBody),
  },
  {
    method: 'post',
    path: '/invoices/:id/void',
    core: action((m, id) => voidInvoice(m, id), plainBody),
  },
  {
    method: 'post',
    path: '/invoices/:id/mark_uncollectible',
    core: action((m, id) => markInvoiceUncollectible(m, id), plainBody),
  },
  { method: 'get', path: '/invoices/:id/lines', core: lines },
  { method: 'get', path: '/invoices/:id/pdf', core: pdf },
  { method: 'post', path: '/invoiceitems', core: createItem },
  { method: 'get', path: '/invoiceitems', core: listItems },
  { method: 'get', path: '/invoiceitems/:id', core: retrieveItem },
  { method: 'post', path: '/invoiceitems/:id', core: updateItem },
  { method: 'delete', path: '/invoiceitems/:id', core: deleteItem },
  { method: 'post', path: '/credit_notes', core: createNote },
  { method: 'get', path: '/credit_notes', core: listNotes },
  { method: 'get', path: '/credit_notes/preview', core: previewNote },
  { method: 'get', path: '/credit_notes/:id', core: retrieveNote },
  { method: 'post', path: '/credit_notes/:id/void', core: voidNote },
  { method: 'post', path: '/customers/:id/balance_transactions', core: createBalance },
  { method: 'get', path: '/customers/:id/balance_transactions', core: listBalance },
  {
    method: 'get',
    path: '/customers/:id/balance_transactions/:transaction',
    core: retrieveBalance,
  },
];
