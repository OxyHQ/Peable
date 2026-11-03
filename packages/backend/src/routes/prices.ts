/**
 * Prices (`price_…`, ADR 0018) — create, retrieve, update, list. A price is
 * never deleted and its amount never changes: archive it (`active: false`)
 * and create another.
 */
import type { Request, Response } from 'express';
import {
  createPriceParams,
  expandOnlyQuery,
  listPricesQuery,
  updatePriceParams,
} from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  findPriceForMerchant,
  listPricesForMerchant,
  type PriceRow,
} from '../db/catalog/priceRepository';
import { findProductForMerchant } from '../db/catalog/productRepository';
import { createPrice, notFound, updatePrice } from '../services/catalog/catalogService';
import { expandObjects, parseExpand } from '../lib/expand';
import { sendError, sendValidationError } from '../lib/http';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  resolveListReference,
  surfaceQuery,
} from '../lib/list';
import { toPriceDTO } from '../lib/serializeCatalog';
import type { CatalogRoute } from './catalogRoutes';

// The request schemas are the contract's (`@peable.to/contracts` `priceRoutes`).
const listQuery = surfaceQuery(listPricesQuery);
const retrieveQuery = surfaceQuery(expandOnlyQuery);

function idParam(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

async function answerPrice(
  res: Response,
  merchant: MerchantRow,
  row: PriceRow,
  expand: readonly string[] | undefined,
): Promise<void> {
  const tree = parseExpand(res, 'price', expand, { list: false });
  if (!tree) return;
  const dto = toPriceDTO(row);
  await expandObjects([dto], 'price', tree, merchant.id);
  res.status(200).json(dto);
}

async function create(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const parsed = createPriceParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (!parseExpand(res, 'price', body.expand, { list: false })) return;
  const price = await createPrice(merchant, {
    product: body.product,
    shape: body.shape,
    active: body.active ?? true,
    lookupKey: body.lookup_key ?? null,
    transferLookupKey: body.transfer_lookup_key ?? false,
    nickname: body.nickname ?? null,
    metadata: body.metadata ?? {},
  });
  await answerPrice(res, merchant, price, body.expand);
}

async function retrieve(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  if (!parseExpand(res, 'price', query.expand, { list: false })) return;
  const price = await findPriceForMerchant(getDb(), id, merchant.id);
  if (!price) throw notFound('price');
  await answerPrice(res, merchant, price, query.expand);
}

async function update(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = updatePriceParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (!parseExpand(res, 'price', body.expand, { list: false })) return;
  const price = await updatePrice(merchant, id, {
    active: body.active,
    nickname: body.nickname,
    metadata: body.metadata,
    lookupKey: body.lookup_key,
    transferLookupKey: body.transfer_lookup_key,
    taxBehavior: body.tax_behavior,
  });
  await answerPrice(res, merchant, price, body.expand);
}

async function list(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, listQuery[surface]);
  if (!query) return;
  const db = getDb();
  const product = await resolveListReference(
    res,
    'product',
    query.product,
    async (publicId) => (await findProductForMerchant(db, publicId, merchant.id))?.id ?? null,
  );
  if (!product.ok) return;
  await answerList(req, res, {
    query,
    type: 'price',
    merchantId: merchant.id,
    cursor: async (publicId) => (await findPriceForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listPricesForMerchant(db, {
        merchantId: merchant.id,
        page,
        productId: product.id,
        active: query.active,
        type: query.type,
        currency: query.currency,
        lookupKeys: query.lookup_keys,
        recurringInterval: query.recurring?.interval,
        recurringUsageType: query.recurring?.usage_type,
      }),
    serialize: toPriceDTO,
  });
}

export const PRICE_ROUTES: readonly CatalogRoute[] = [
  { method: 'post', path: '/prices', core: create },
  { method: 'get', path: '/prices', core: list },
  { method: 'get', path: '/prices/:id', core: retrieve },
  { method: 'post', path: '/prices/:id', core: update },
];
