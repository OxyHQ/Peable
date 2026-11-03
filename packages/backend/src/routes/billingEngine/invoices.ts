/**
 * Invoices (`in_…`), invoice items (`ii_…`), credit notes (`cn_…`) and the
 * customer balance ledger — ADR 0018 §2–4.
 */
import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  createCreditNoteParams,
  createCustomerBalanceTransactionParams,
  createInvoiceItemParams,
  createInvoiceParams,
  expandOnlyQuery,
  finalizeInvoiceParams,
  invoiceActionParams,
  listCreditNotesQuery,
  listCustomerBalanceTransactionsQuery,
  listInvoiceItemsQuery,
  listInvoicesQuery,
  payInvoiceParams,
  previewCreditNoteQuery,
  upcomingInvoiceQuery,
  updateInvoiceItemParams,
  updateInvoiceParams,
  voidCreditNoteParams,
} from '@peable.to/contracts';
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
import { priceDataSchema } from '../../services/catalog/params';
import { answerList, parseQuery, type QuerySurface, resolveListReference } from '../../lib/list';
import { sendValidationError } from '../../lib/http';
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
import { answerObject, bySurface, cleared, idParam, parseBody } from './helpers';

/**
 * Every request schema is the contract's (`@peable.to/contracts`
 * `invoiceRoutes`, `invoiceItemRoutes`, `creditNoteRoutes`,
 * `customerBalanceTransactionRoutes`); the dashboard's reads add only its
 * Test/Live toggle.
 */
const listQuery = bySurface(listInvoicesQuery);
const retrieveQuery = bySurface(expandOnlyQuery);
const upcomingSurface = bySurface(upcomingInvoiceQuery);

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
  const body = parseBody(req, res, createInvoiceParams);
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
  const body = parseBody(req, res, updateInvoiceParams);
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

type InvoiceActionBody = z.output<typeof payInvoiceParams> & z.output<typeof finalizeInvoiceParams>;

function action(
  run: (
    merchant: MerchantRow,
    id: string,
    body: InvoiceActionBody,
  ) => Promise<{ publicId: string }>,
  schema: typeof payInvoiceParams | typeof finalizeInvoiceParams | typeof invoiceActionParams,
) {
  return async (req: Request, res: Response, merchant: MerchantRow) => {
    const id = idParam(req, res);
    if (!id) return;
    const body: InvoiceActionBody | null = parseBody(req, res, schema);
    if (!body) return;
    const row = await run(merchant, id, body);
    await answer(res, merchant, row.publicId, body.expand);
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

const listItemsQuery = bySurface(listInvoiceItemsQuery);

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

/**
 * The stored shape of an inline `price_data`: the contract checked its fields,
 * the catalog applies its pricing rules (the per-currency bound, the interval
 * limit) — the same rules every other `price_data` meets. A broken rule is the
 * same 400, under `price_data`.
 */
function inlinePriceShape(
  res: Response,
  priceData: z.output<typeof createInvoiceItemParams>['price_data'],
): { ok: true; value: z.output<typeof priceDataSchema> | undefined } | { ok: false } {
  if (priceData === undefined) return { ok: true, value: undefined };
  const parsed = priceDataSchema.safeParse(priceData);
  if (parsed.success) return { ok: true, value: parsed.data };
  sendValidationError(res, {
    issues: parsed.error.issues.map((issue) => ({ ...issue, path: ['price_data', ...issue.path] })),
  });
  return { ok: false };
}

async function createItem(req: Request, res: Response, merchant: MerchantRow) {
  const body = parseBody(req, res, createInvoiceItemParams);
  if (!body) return;
  const priceData = inlinePriceShape(res, body.price_data);
  if (!priceData.ok) return;
  const row = await createInvoiceItem(merchant, {
    customer: body.customer,
    ...(body.invoice ? { invoice: body.invoice } : {}),
    ...(body.subscription ? { subscription: body.subscription } : {}),
    ...(body.price ? { price: body.price } : {}),
    ...(priceData.value ? { priceData: priceData.value } : {}),
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
  const body = parseBody(req, res, updateInvoiceItemParams);
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

type CreditNoteFields = z.output<typeof previewCreditNoteQuery> & {
  readonly metadata?: Record<string, string> | undefined;
};

function creditNoteInput(body: CreditNoteFields) {
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

const previewSurface = bySurface(previewCreditNoteQuery);
const listCreditNotesSurface = bySurface(listCreditNotesQuery);

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
  const body = parseBody(req, res, createCreditNoteParams);
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
  res.status(200).json(await previewCreditNote(merchant, creditNoteInput(query)));
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
  const body = parseBody(req, res, voidCreditNoteParams);
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
  const query = parseQuery(req, res, listCreditNotesSurface[surface]);
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

const listBalanceQuery = bySurface(listCustomerBalanceTransactionsQuery);

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
  const body = parseBody(req, res, createCustomerBalanceTransactionParams);
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
      finalizeInvoiceParams,
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
      payInvoiceParams,
    ),
  },
  {
    method: 'post',
    path: '/invoices/:id/send',
    core: action((m, id) => sendInvoice(m, id), invoiceActionParams),
  },
  {
    method: 'post',
    path: '/invoices/:id/void',
    core: action((m, id) => voidInvoice(m, id), invoiceActionParams),
  },
  {
    method: 'post',
    path: '/invoices/:id/mark_uncollectible',
    core: action((m, id) => markInvoiceUncollectible(m, id), invoiceActionParams),
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
