/**
 * Coupons (ADR 0018) — create, retrieve, update (name and metadata), list,
 * delete. A coupon's id is the merchant's own or a generated `coupon_…`.
 */
import type { Request, Response } from 'express';
import {
  createCouponParams,
  expandOnlyQuery,
  listCouponsQuery,
  updateCouponParams,
} from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  findCouponForMerchant,
  listCouponsForMerchant,
  type CouponRow,
} from '../db/catalog/couponRepository';
import {
  CatalogError,
  createCoupon,
  deleteCoupon,
  notFound,
  updateCoupon,
} from '../services/catalog/catalogService';
import { expandObjects, parseExpand } from '../lib/expand';
import { sendError, sendValidationError } from '../lib/http';
import { answerList, parseQuery, type QuerySurface, surfaceQuery } from '../lib/list';
import { toCouponDTO } from '../lib/serializeCatalog';
import { fromUnix } from '../lib/time';
import type { CatalogRoute } from './catalogRoutes';

// The request schemas are the contract's (`@peable.to/contracts` `couponRoutes`).
const listQuery = surfaceQuery(listCouponsQuery);
const retrieveQuery = surfaceQuery(expandOnlyQuery);

function idParam(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

async function answerCoupon(
  res: Response,
  merchant: MerchantRow,
  row: CouponRow,
  expand: readonly string[] | undefined,
): Promise<void> {
  const tree = parseExpand(res, 'coupon', expand, { list: false });
  if (!tree) return;
  const dto = toCouponDTO(row);
  await expandObjects([dto], 'coupon', tree, merchant.id);
  res.status(200).json(dto);
}

async function create(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const parsed = createCouponParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (!parseExpand(res, 'coupon', body.expand, { list: false })) return;
  if (body.redeem_by !== undefined && fromUnix(body.redeem_by).getTime() <= Date.now()) {
    throw new CatalogError('parameter_invalid', 'redeem_by must be in the future', 'redeem_by');
  }
  const coupon = await createCoupon(merchant, {
    id: body.id,
    name: body.name ?? null,
    percentOffBps: body.percent_off ?? null,
    amountOff: body.amount_off ?? null,
    currency: body.currency ?? null,
    duration: body.duration ?? 'once',
    durationInMonths: body.duration_in_months ?? null,
    maxRedemptions: body.max_redemptions ?? null,
    redeemBy: body.redeem_by === undefined ? null : fromUnix(body.redeem_by),
    metadata: body.metadata ?? {},
    appliesTo: body.applies_to?.products,
  });
  await answerCoupon(res, merchant, coupon, body.expand);
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
  if (!parseExpand(res, 'coupon', query.expand, { list: false })) return;
  const coupon = await findCouponForMerchant(getDb(), id, merchant.id);
  if (!coupon) throw notFound('coupon');
  await answerCoupon(res, merchant, coupon, query.expand);
}

async function update(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = updateCouponParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (!parseExpand(res, 'coupon', body.expand, { list: false })) return;
  const coupon = await updateCoupon(merchant, id, { name: body.name, metadata: body.metadata });
  await answerCoupon(res, merchant, coupon, body.expand);
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
    type: 'coupon',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findCouponForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) => listCouponsForMerchant(db, { merchantId: merchant.id, page }),
    serialize: (row) => toCouponDTO(row),
  });
}

async function remove(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const deleted = await deleteCoupon(merchant, id);
  res.status(200).json({ id: deleted.publicId, object: 'coupon', deleted: true });
}

export const COUPON_ROUTES: readonly CatalogRoute[] = [
  { method: 'post', path: '/coupons', core: create },
  { method: 'get', path: '/coupons', core: list },
  { method: 'get', path: '/coupons/:id', core: retrieve },
  { method: 'post', path: '/coupons/:id', core: update },
  { method: 'delete', path: '/coupons/:id', core: remove },
];
