// The rest of Orbit's native billing engine (ADR 0018): test clocks, the
// merchant's billing settings (numbering and dunning), usage meters,
// entitlements and the customer portal.
import type { ListParams } from './list';

// ---- Test clocks, billing settings, meters, entitlements --------------------------
// The contract's (`@peable.to/contracts`): types re-exported, the closed value
// sets from its zod-free vocabulary.
export {
  BILLING_SETTINGS_LIMITS,
  DUNNING_FINAL_ACTIONS,
  DUNNING_INVOICE_ACTIONS,
  type DunningFinalAction,
  type DunningInvoiceAction,
  METER_AGGREGATIONS,
  METER_STATUSES,
  type MeterAggregation,
  type MeterStatus,
  TEST_CLOCK_STATUSES,
  type TestClockStatus,
} from '@peable.to/contracts/vocabulary';
export type {
  ActiveEntitlement,
  ActiveEntitlementListParams,
  ActiveEntitlementSummary,
  AdvanceTestClockParams,
  AttachProductFeatureParams,
  BillingMeter,
  BillingMeterEvent,
  BillingMeterEventSummary,
  BillingMeterEventSummaryParams,
  BillingMeterListParams,
  BillingSettings,
  CreateBillingMeterEventParams,
  CreateBillingMeterParams,
  CreateEntitlementFeatureParams,
  CreateTestClockParams,
  DeletedProductFeature,
  DeletedTestClock,
  EntitlementFeature,
  EntitlementFeatureListParams,
  ProductFeature,
  ProductFeatureListParams,
  TestClock,
  TestClockListParams,
  UpdateBillingMeterParams,
  UpdateBillingSettingsParams,
  UpdateEntitlementFeatureParams,
} from '@peable.to/contracts';

// ---- Customer portal -------------------------------------------------------------------
//
// The portal's wire types are the contract's (`@peable.to/contracts`
// `billingPortal` and `public` modules), re-exported here as types.

export {
  PORTAL_CUSTOMER_UPDATES,
  type PortalCustomerUpdate,
} from '@peable.to/contracts/vocabulary';

export type {
  BillingPortalBusinessProfile,
  BillingPortalConfiguration,
  BillingPortalConfigurationListParams,
  BillingPortalFeatures,
  BillingPortalSession,
  CreateBillingPortalConfigurationParams,
  CreateBillingPortalSessionParams,
  PortalPaymentMethodUpdate,
  PortalPaymentMethodUpdateResult,
  PublicPortalSession,
  PublicPortalSubscription,
  UpdateBillingPortalConfigurationParams,
} from '@peable.to/contracts';
