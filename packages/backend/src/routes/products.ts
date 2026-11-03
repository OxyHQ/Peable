/**
 * Products (`prod_…`, ADR 0018) — create, retrieve, update, list, delete.
 * Deleting is only for a product nothing names; archive with `active: false`.
 */
import type { Request, Response } from 'express';
import {
  createProductParams,
  expandOnlyQuery,
  listProductsQuery,
  updateProductParams,
} from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  findProductForMerchant,
  listProductsForMerchant,
  type ProductRow,
} from '../db/catalog/productRepository';
import {
  createProduct,
  deleteProduct,
  notFound,
  updateProduct,
} from '../services/catalog/catalogService';
import { expandObjects, parseExpand } from '../lib/expand';
import { sendError, sendValidationError } from '../lib/http';
import { answerList, parseQuery, type QuerySurface, surfaceQuery } from '../lib/list';
import { toProductDTO } from '../lib/serializeCatalog';
import type { CatalogRoute } from './catalogRoutes';

// The request schemas are the contract's (`@peable.to/contracts` `productRoutes`).
const listQuery = surfaceQuery(listProductsQuery);
const retrieveQuery = surfaceQuery(expandOnlyQuery);

function idParam(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

/** Answer one product, expanded as asked. */
async function answerProduct(
  res: Response,
  merchant: MerchantRow,
  row: ProductRow,
  expand: readonly string[] | undefined,
): Promise<void> {
  const tree = parseExpand(res, 'product', expand, { list: false });
  if (!tree) return;
  const dto = toProductDTO(row);
  await expandObjects([dto], 'product', tree, merchant.id);
  res.status(200).json(dto);
}

async function create(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const parsed = createProductParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (!parseExpand(res, 'product', body.expand, { list: false })) return;
  const product = await createProduct(merchant, {
    name: body.name,
    active: body.active ?? true,
    description: body.description ?? null,
    images: body.images ?? [],
    metadata: body.metadata ?? {},
    taxCode: body.tax_code ?? null,
    unitLabel: body.unit_label ?? null,
    url: body.url ?? null,
    statementDescriptor: body.statement_descriptor ?? null,
    marketingFeatures: body.marketing_features ?? [],
    defaultPrice: body.default_price_data,
  });
  await answerProduct(res, merchant, product, body.expand);
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
  if (!parseExpand(res, 'product', query.expand, { list: false })) return;
  const product = await findProductForMerchant(getDb(), id, merchant.id);
  if (!product) throw notFound('product');
  await answerProduct(res, merchant, product, query.expand);
}

async function update(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = updateProductParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (!parseExpand(res, 'product', body.expand, { list: false })) return;
  const product = await updateProduct(merchant, id, {
    name: body.name,
    active: body.active,
    description: body.description,
    images: body.images,
    metadata: body.metadata,
    taxCode: body.tax_code,
    defaultPrice: body.default_price,
    unitLabel: body.unit_label,
    url: body.url,
    statementDescriptor: body.statement_descriptor,
    marketingFeatures: body.marketing_features,
  });
  await answerProduct(res, merchant, product, body.expand);
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
  await answerList(req, res, {
    query,
    type: 'product',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findProductForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listProductsForMerchant(db, {
        merchantId: merchant.id,
        page,
        active: query.active,
        ids: query.ids,
      }),
    serialize: toProductDTO,
  });
}

async function remove(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const deleted = await deleteProduct(merchant, id);
  res.status(200).json({ id: deleted.publicId, object: 'product', deleted: true });
}

export const PRODUCT_ROUTES: readonly CatalogRoute[] = [
  { method: 'post', path: '/products', core: create },
  { method: 'get', path: '/products', core: list },
  { method: 'get', path: '/products/:id', core: retrieve },
  { method: 'post', path: '/products/:id', core: update },
  { method: 'delete', path: '/products/:id', core: remove },
];
