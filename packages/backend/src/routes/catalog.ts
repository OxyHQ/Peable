import type { RequestHandler, Router } from 'express';
import { type CatalogRoute, createCatalogApiRouter } from './catalogRoutes';
import { COUPON_ROUTES } from './coupons';
import { PRICE_ROUTES } from './prices';
import { PRODUCT_ROUTES } from './products';
import { PROMOTION_CODE_ROUTES } from './promotionCodes';

/**
 * Every catalog route (ADR 0018): `/v1/products`, `/v1/prices`, `/v1/coupons`
 * and `/v1/promotion_codes`, mounted once on the merchant API here and once on
 * Orbit's dashboard (`routes/dashboard.ts`) from the same list.
 */
export const CATALOG_ROUTES: readonly CatalogRoute[] = [
  ...PRODUCT_ROUTES,
  ...PRICE_ROUTES,
  ...COUPON_ROUTES,
  ...PROMOTION_CODE_ROUTES,
];

export function createCatalogRouter(deps: { requireMerchant: RequestHandler }): Router {
  return createCatalogApiRouter(CATALOG_ROUTES, deps);
}
