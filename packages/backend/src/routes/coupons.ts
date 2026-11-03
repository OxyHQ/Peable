/**
 * Coupons (ADR 0018) — create, retrieve, update (name and metadata), list,
 * delete. A coupon's id is the merchant's own or a generated `coupon_…`.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CATALOG_LIMITS, COUPON_DURATIONS, type CreateCouponParams } from '@peable.to/shared-types';
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
import {
  amountSchema,
  checkAmountBound,
  clearable,
  couponIdSchema,
  currencySchema,
  percentOffSchema,
  redemptionsSchema,
  unixSecondsSchema,
} from '../services/catalog/params';
import { expandObjects, parseExpand } from '../lib/expand';
import { sendError, sendValidationError } from '../lib/http';
import {
  answerList,
  expandParam,
  parseQuery,
  type QuerySurface,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../lib/list';
import { metadataCreateSchema, metadataUpdateSchema } from '../lib/metadata';
import { toCouponDTO } from '../lib/serializeCatalog';
import { fromUnix } from '../lib/time';
import type { CatalogRoute } from './catalogRoutes';

const nameSchema = z.string().min(1).max(CATALOG_LIMITS.couponNameMax);

const createBodySchema = z
  .object({
    id: couponIdSchema.optional(),
    name: nameSchema.optional(),
    percent_off: percentOffSchema.optional(),
    amount_off: amountSchema.optional(),
    currency: currencySchema.optional(),
    duration: z.enum(COUPON_DURATIONS).optional(),
    duration_in_months: z
      .number()
      .int()
      .min(1)
      .max(CATALOG_LIMITS.couponDurationInMonthsMax)
      .optional(),
    max_redemptions: redemptionsSchema.optional(),
    redeem_by: unixSecondsSchema.optional(),
    applies_to: z
      .object({
        products: z
          .array(z.string().min(1).max(255))
          .min(1)
          .max(CATALOG_LIMITS.couponAppliesToProductsMax),
      })
      .strict()
      .optional(),
    metadata: metadataCreateSchema.optional(),
    expand: expandParam.optional(),
  } satisfies Record<keyof CreateCouponParams | 'expand', z.ZodTypeAny>)
  .strict()
  .superRefine((body, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if ((body.percent_off === undefined) === (body.amount_off === undefined)) {
      issue('percent_off', 'a coupon takes exactly one of percent_off and amount_off');
    }
    if (body.amount_off !== undefined && body.currency === undefined) {
      issue('currency', 'amount_off needs a currency');
    }
    if (body.amount_off === undefined && body.currency !== undefined) {
      issue('currency', 'currency is only for an amount_off coupon');
    }
    if (body.amount_off === '0') issue('amount_off', 'amount_off must be positive');
    checkAmountBound(ctx, body.amount_off, body.currency, ['amount_off']);
    const duration = body.duration ?? 'once';
    if (duration === 'repeating' && body.duration_in_months === undefined) {
      issue('duration_in_months', 'a repeating coupon needs duration_in_months');
    }
    if (duration !== 'repeating' && body.duration_in_months !== undefined) {
      issue('duration_in_months', 'duration_in_months is only for a repeating coupon');
    }
  });

const updateBodySchema = z
  .object({
    name: clearable(nameSchema).optional(),
    metadata: metadataUpdateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();

const listCouponsQuery = surfaceListQuery({});
const retrieveCouponQuery = surfaceRetrieveQuery();

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
  const parsed = createBodySchema.safeParse(req.body ?? {});
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
  const query = parseQuery(req, res, retrieveCouponQuery[surface]);
  if (!query) return;
  if (!parseExpand(res, 'coupon', query.expand, { list: false })) return;
  const coupon = await findCouponForMerchant(getDb(), id, merchant.id);
  if (!coupon) throw notFound('coupon');
  await answerCoupon(res, merchant, coupon, query.expand);
}

async function update(req: Request, res: Response, merchant: MerchantRow): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = updateBodySchema.safeParse(req.body ?? {});
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
  const query = parseQuery(req, res, listCouponsQuery[surface]);
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
