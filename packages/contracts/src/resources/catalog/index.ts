// Contracts of this group: one module per resource, re-exported here, and
// their routes concatenated into `catalogRoutes`.
import { billingRoutes } from './billing';
import { billingSettingsRoutes } from './billingSettings';
import { couponRoutes } from './coupons';
import { entitlementRoutes } from './entitlements';
import { meterRoutes } from './meters';
import { priceRoutes } from './prices';
import { productRoutes } from './products';
import { promotionCodeRoutes } from './promotionCodes';
import { testClockRoutes } from './testClocks';

export * from './billing';
export * from './billingSettings';
export * from './coupons';
export * from './entitlements';
export * from './meters';
export * from './prices';
export * from './products';
export * from './promotionCodes';
export * from './testClocks';
// The request pieces every body naming an amount, an inline price or a filter reuses.
export { baseUnitAmountParam, queryFlag, queryIdList } from './shared';

/**
 * The catalog (products, prices, coupons, promotion codes), entitlements, the
 * billing engine's platform objects (test clocks, billing settings, meters)
 * and the recurring billing transport (`/v1/billing/*`).
 */
export const catalogRoutes = [
  ...productRoutes,
  ...priceRoutes,
  ...couponRoutes,
  ...promotionCodeRoutes,
  ...entitlementRoutes,
  ...testClockRoutes,
  ...billingSettingsRoutes,
  ...meterRoutes,
  ...billingRoutes,
] as const;
