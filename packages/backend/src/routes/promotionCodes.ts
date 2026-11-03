/**
 * Promotion codes (`promo_…`, ADR 0018) — create, retrieve, update (`active`,
 * `metadata`), list (`code` case-insensitive, `coupon`, `customer`, `active`).
 */
import type { Request, Response } from 'express';
import {
  createPromotionCodeParams,
  expandOnlyQuery,
  listPromotionCodesQuery,
  updatePromotionCodeParams,
} from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findCouponForMerchant } from '../db/catalog/couponRepository';
import {
  findPromotionCodeForMerchant,
  listPromotionCodesForMerchant,
  type PromotionCodeRow,
} from '../db/catalog/promotionCodeRepository';
import { findCustomerForMerchant } from '../db/customers/customerRepository';
import {
  CatalogError,
  createPromotionCode,
  notFound,
  updatePromotionCode,
} from '../services/catalog/catalogService';
import { expandObjects, parseExpand } from '../lib/expand';
import { sendError, sendValidationError } from '../lib/http';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  resolveListReference,
  surfaceQuery,
} from '../lib/list';
import { toPromotionCodeDTO } from '../lib/serializeCatalog';
import { fromUnix } from '../lib/time';
import type { CatalogRoute } from './catalogRoutes';

// The request schemas are the contract's (`@peable.to/contracts` `promotionCodeRoutes`).
const listQuery = surfaceQuery(listPromotionCodesQuery);
const retrieveQuery = surfaceQuery(expandOnlyQuery);

function idParam(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

async function answerPromotionCode(
  res: Response,
  merchant: MerchantRow,
  row: PromotionCodeRow,
  expand: readonly string[] | undefined,
): Promise<void> {
  const tree = parseExpand(res, 'promotion_code', expand, { list: false });
  if (!tree) return;
  const dto = toPromotionCodeDTO(row);
  await expandObjects([dto], 'promotion_code', tree, merchant.id);
  res.status(200).json(dto);
}

async function create(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const parsed = createPromotionCodeParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (!parseExpand(res, 'promotion_code', body.expand, { list: false })) return;
  if (body.expires_at !== undefined && fromUnix(body.expires_at).getTime() <= Date.now()) {
    throw new CatalogError('parameter_invalid', 'expires_at must be in the future', 'expires_at');
  }
  const code = await createPromotionCode(merchant, {
    coupon: body.coupon,
    code: body.code,
    customer: body.customer,
    active: body.active ?? true,
    maxRedemptions: body.max_redemptions ?? null,
    expiresAt: body.expires_at === undefined ? null : fromUnix(body.expires_at),
    firstTimeTransaction: body.restrictions?.first_time_transaction ?? false,
    minimumAmount: body.restrictions?.minimum_amount ?? null,
    minimumAmountCurrency: body.restrictions?.minimum_amount_currency ?? null,
    metadata: body.metadata ?? {},
  });
  await answerPromotionCode(res, merchant, code, body.expand);
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
  if (!parseExpand(res, 'promotion_code', query.expand, { list: false })) return;
  const code = await findPromotionCodeForMerchant(getDb(), id, merchant.id);
  if (!code) throw notFound('promotion code');
  await answerPromotionCode(res, merchant, code, query.expand);
}

async function update(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = updatePromotionCodeParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (!parseExpand(res, 'promotion_code', body.expand, { list: false })) return;
  const code = await updatePromotionCode(merchant, id, {
    active: body.active,
    metadata: body.metadata,
  });
  await answerPromotionCode(res, merchant, code, body.expand);
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
  const coupon = await resolveListReference(
    res,
    'coupon',
    query.coupon,
    async (publicId) =>
      (await findCouponForMerchant(db, publicId, merchant.id, { includeDeleted: true }))?.id ??
      null,
  );
  if (!coupon.ok) return;
  const customer = await resolveListReference(
    res,
    'customer',
    query.customer,
    async (publicId) => (await findCustomerForMerchant(db, publicId, merchant.id))?.id ?? null,
  );
  if (!customer.ok) return;
  await answerList(req, res, {
    query,
    type: 'promotion_code',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findPromotionCodeForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listPromotionCodesForMerchant(db, {
        merchantId: merchant.id,
        page,
        code: query.code,
        couponId: coupon.id,
        customerId: customer.id,
        active: query.active,
      }),
    serialize: toPromotionCodeDTO,
  });
}

export const PROMOTION_CODE_ROUTES: readonly CatalogRoute[] = [
  { method: 'post', path: '/promotion_codes', core: create },
  { method: 'get', path: '/promotion_codes', core: list },
  { method: 'get', path: '/promotion_codes/:id', core: retrieve },
  { method: 'post', path: '/promotion_codes/:id', core: update },
];
