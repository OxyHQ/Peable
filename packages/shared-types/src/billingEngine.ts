// The rest of Orbit's native billing engine (ADR 0018): test clocks, the
// merchant's billing settings (numbering and dunning), usage meters,
// entitlements and the customer portal.
import type { Customer } from './customer';
import type { ListParams } from './list';
import type { Invoice } from './invoice';
import type { Subscription } from './subscription';

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

/** One subscription as the hosted portal shows it. */
export type PublicPortalSubscription = Pick<
  Subscription,
  | 'id'
  | 'status'
  | 'currency'
  | 'current_period_end'
  | 'cancel_at_period_end'
  | 'cancel_at'
  | 'trial_end'
  | 'collection_method'
> & {
  items: {
    id: string;
    price: string;
    product: string;
    product_name: string;
    quantity: number;
    unit_amount: string | null;
    interval: string | null;
  }[];
};

// ---- Customer portal -------------------------------------------------------------------

/** What a portal customer may edit about themselves. */
export const PORTAL_CUSTOMER_UPDATES = ['email', 'name', 'address', 'phone'] as const;
export type PortalCustomerUpdate = (typeof PORTAL_CUSTOMER_UPDATES)[number];

export interface BillingPortalFeatures {
  customer_update: { enabled: boolean; allowed_updates: PortalCustomerUpdate[] };
  invoice_history: { enabled: boolean };
  payment_method_update: { enabled: boolean };
  subscription_cancel: {
    enabled: boolean;
    mode: 'at_period_end' | 'immediately';
    proration_behavior: 'create_prorations' | 'none';
  };
  subscription_update: {
    enabled: boolean;
    default_allowed_updates: ('price' | 'quantity')[];
    proration_behavior: 'create_prorations' | 'none' | 'always_invoice';
    /** The plans a customer may switch between: per product, its allowed prices. */
    products: { product: string; prices: string[] }[];
  };
}

/** A portal configuration (`bpc_…`) — what the hosted portal lets a customer do. */
export interface BillingPortalConfiguration {
  id: string;
  object: 'billing_portal.configuration';
  livemode: boolean;
  active: boolean;
  is_default: boolean;
  business_profile: {
    headline: string | null;
    privacy_policy_url: string | null;
    terms_of_service_url: string | null;
  };
  default_return_url: string | null;
  features: BillingPortalFeatures;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface CreateBillingPortalConfigurationParams {
  business_profile?: DeepPartial<BillingPortalConfiguration['business_profile']>;
  default_return_url?: string;
  features: DeepPartial<BillingPortalFeatures>;
  metadata?: Record<string, string>;
}

export interface UpdateBillingPortalConfigurationParams {
  active?: boolean;
  business_profile?: DeepPartial<BillingPortalConfiguration['business_profile']>;
  default_return_url?: string | '';
  features?: DeepPartial<BillingPortalFeatures>;
  metadata?: Record<string, string>;
}

export interface BillingPortalConfigurationListParams extends ListParams {
  active?: boolean;
  is_default?: boolean;
}

/**
 * A portal session (`bps_…`): a short-lived URL for ONE customer. The URL is
 * a bearer credential — hand it to that customer only, right away.
 */
export interface BillingPortalSession {
  id: string;
  object: 'billing_portal.session';
  livemode: boolean;
  customer: string;
  configuration: string;
  return_url: string | null;
  url: string;
  /** The URL stops working after this instant. */
  expires_at: number;
  created: number;
}

export interface CreateBillingPortalSessionParams {
  customer: string;
  /** Default: the merchant's default configuration (created on first use). */
  configuration?: string;
  return_url?: string;
}

/** The hosted portal's view of its customer (payer-facing, `GET /v1/billing_portal/public/:token`). */
export interface PublicPortalSession {
  object: 'billing_portal.public_session';
  livemode: boolean;
  merchant: { name: string | null; avatar_url: string | null };
  business_profile: BillingPortalConfiguration['business_profile'];
  features: BillingPortalFeatures;
  return_url: string | null;
  expires_at: number;
  customer: Pick<Customer, 'id' | 'email' | 'name' | 'phone' | 'address'> & {
    default_payment_method: {
      id: string;
      card: { brand: string; last4: string; exp_month: number; exp_year: number } | null;
    } | null;
  };
  subscriptions: PublicPortalSubscription[];
  invoices: Pick<
    Invoice,
    | 'id'
    | 'number'
    | 'status'
    | 'currency'
    | 'total'
    | 'amount_due'
    | 'created'
    | 'hosted_invoice_url'
    | 'invoice_pdf'
  >[];
  /** The plans `subscription_update` allows, priced. */
  plans: {
    product: string;
    product_name: string;
    prices: {
      id: string;
      unit_amount: string | null;
      currency: string;
      interval: string | null;
      interval_count: number | null;
    }[];
  }[];
}
