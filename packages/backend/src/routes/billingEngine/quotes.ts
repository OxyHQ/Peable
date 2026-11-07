/**
 * Quotes (`qt_…`) — ADR 0018 §5. Every request schema is the contract's
 * (`@peable.to/contracts` `quoteRoutes`); the dashboard's reads add only its
 * Test/Live toggle.
 */
import type { Request, Response } from 'express';
import {
  createQuoteParams,
  expandOnlyQuery,
  finalizeQuoteParams,
  listQuoteLineItemsQuery,
  listQuotesQuery,
  quoteActionParams,
  updateQuoteParams,
} from '@peable.to/contracts';
import { findCustomerForMerchant } from '../../db/customers/customerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  findQuoteForMerchant,
  listQuoteLines,
  listQuotes,
} from '../../db/billingEngine/quoteRepository';
import { getDb } from '../../db/postgres';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  resolveListReference,
  surfaceQuery,
} from '../../lib/list';
import { toQuoteDTO, toQuoteLineItemDTO } from '../../lib/serializeBilling';
import { missing } from '../../services/billingEngine/errors';
import { quotePdf } from '../../services/billingEngine/quotePdf';
import {
  acceptQuote,
  cancelQuote,
  createQuote,
  finalizeQuote,
  updateDraftQuote,
} from '../../services/billingEngine/quotes';
import type { CatalogRoute } from '../catalogRoutes';
import { answerObject, cleared, idParam, parseBody } from './helpers';

const listQuery = surfaceQuery(listQuotesQuery);
const retrieveQuery = surfaceQuery(expandOnlyQuery);
const linesQuery = surfaceQuery(listQuoteLineItemsQuery);

async function answer(
  res: Response,
  merchant: MerchantRow,
  publicId: string,
  expand: readonly string[] | undefined,
) {
  const row = await findQuoteForMerchant(getDb(), publicId, merchant.id);
  if (!row) throw missing('quote');
  await answerObject(res, merchant, 'quote', toQuoteDTO(row), expand);
}

async function create(req: Request, res: Response, merchant: MerchantRow) {
  const body = parseBody(req, res, createQuoteParams);
  if (!body) return;
  const row = await createQuote(merchant, {
    customer: body.customer,
    lineItems: body.line_items,
    ...(body.collection_method ? { collectionMethod: body.collection_method } : {}),
    ...(body.invoice_settings?.days_until_due !== undefined
      ? { daysUntilDue: body.invoice_settings.days_until_due }
      : {}),
    ...(body.subscription_data
      ? {
          subscriptionData: {
            description: body.subscription_data.description,
            trialPeriodDays: body.subscription_data.trial_period_days,
            metadata: body.subscription_data.metadata,
          },
        }
      : {}),
    ...(body.discounts ? { discounts: body.discounts } : {}),
    ...(body.automatic_tax ? { automaticTax: body.automatic_tax.enabled } : {}),
    ...(body.expires_at !== undefined ? { expiresAt: body.expires_at } : {}),
    ...(body.header ? { header: body.header } : {}),
    ...(body.description ? { description: body.description } : {}),
    ...(body.footer ? { footer: body.footer } : {}),
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
  const body = parseBody(req, res, updateQuoteParams);
  if (!body) return;
  const row = await updateDraftQuote(merchant, id, {
    ...(body.line_items ? { lineItems: body.line_items } : {}),
    ...(body.collection_method ? { collectionMethod: body.collection_method } : {}),
    ...(body.invoice_settings?.days_until_due !== undefined
      ? { daysUntilDue: body.invoice_settings.days_until_due }
      : {}),
    ...(body.subscription_data
      ? {
          subscriptionData: {
            description: body.subscription_data.description,
            trialPeriodDays: body.subscription_data.trial_period_days,
            metadata: body.subscription_data.metadata,
          },
        }
      : {}),
    ...(body.discounts !== undefined ? { discounts: cleared(body.discounts) ?? null } : {}),
    ...(body.automatic_tax ? { automaticTax: body.automatic_tax.enabled } : {}),
    ...(body.expires_at !== undefined ? { expiresAt: body.expires_at } : {}),
    ...(body.header !== undefined ? { header: cleared(body.header) ?? null } : {}),
    ...(body.description !== undefined ? { description: cleared(body.description) ?? null } : {}),
    ...(body.footer !== undefined ? { footer: cleared(body.footer) ?? null } : {}),
    ...(body.metadata ? { metadata: body.metadata } : {}),
  });
  await answer(res, merchant, row.publicId, body.expand);
}

async function finalize(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, finalizeQuoteParams);
  if (!body) return;
  const row = await finalizeQuote(merchant, id, {
    ...(body.expires_at !== undefined ? { expiresAt: body.expires_at } : {}),
  });
  await answer(res, merchant, row.publicId, body.expand);
}

function action(run: (merchant: MerchantRow, id: string) => Promise<{ publicId: string }>) {
  return async (req: Request, res: Response, merchant: MerchantRow) => {
    const id = idParam(req, res);
    if (!id) return;
    const body = parseBody(req, res, quoteActionParams);
    if (!body) return;
    const row = await run(merchant, id);
    await answer(res, merchant, row.publicId, body.expand);
  };
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
  await answerList(req, res, {
    query,
    type: 'quote',
    merchantId: merchant.id,
    cursor: async (publicId) => (await findQuoteForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listQuotes(db, {
        merchantId: merchant.id,
        page,
        customerId: customer.id,
        status: query.status,
      }),
    serialize: toQuoteDTO,
  });
}

async function lineItems(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, linesQuery[surface]);
  if (!query) return;
  const db = getDb();
  const quote = await findQuoteForMerchant(db, id, merchant.id);
  if (!quote) throw missing('quote');
  // At most twenty lines; the list contract pages over them in their order,
  // the cursor being a line's own `li_…`.
  const lines = await listQuoteLines(db, quote.id);
  await answerList(req, res, {
    query: { ...query, created: undefined },
    type: 'item',
    merchantId: merchant.id,
    cursor: async (publicId) => lines.find((line) => line.publicId === publicId)?.id ?? null,
    fetch: async (page) => {
      const index = (lineId: string | undefined) =>
        lineId === undefined ? -1 : lines.findIndex((line) => line.id === lineId);
      let window = lines;
      if (page.after !== undefined) window = lines.slice(index(page.after) + 1);
      else if (page.before !== undefined) {
        const end = index(page.before);
        window = lines.slice(Math.max(0, end - page.limit), end);
        return { data: window, hasMore: end - page.limit > 0 };
      }
      return { data: window.slice(0, page.limit), hasMore: window.length > page.limit };
    },
    serialize: toQuoteLineItemDTO,
  });
}

async function pdf(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const quote = await findQuoteForMerchant(getDb(), id, merchant.id);
  if (!quote) throw missing('quote');
  const document = await quotePdf(quote);
  res
    .status(200)
    .type('application/pdf')
    .setHeader('Content-Disposition', `inline; filename="${quote.number ?? quote.publicId}.pdf"`);
  res.end(Buffer.from(document));
}

export const QUOTE_ROUTES: readonly CatalogRoute[] = [
  { method: 'post', path: '/quotes', core: create },
  { method: 'get', path: '/quotes', core: list },
  { method: 'get', path: '/quotes/:id', core: retrieve },
  { method: 'post', path: '/quotes/:id', core: update },
  { method: 'post', path: '/quotes/:id/finalize', core: finalize },
  { method: 'post', path: '/quotes/:id/accept', core: action(acceptQuote) },
  { method: 'post', path: '/quotes/:id/cancel', core: action(cancelQuote) },
  { method: 'get', path: '/quotes/:id/line_items', core: lineItems },
  { method: 'get', path: '/quotes/:id/pdf', core: pdf },
];
