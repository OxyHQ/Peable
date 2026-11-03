// The rest of Orbit's native billing engine (ADR 0018): test clocks, the
// merchant's billing settings (numbering and dunning), usage meters,
// entitlements and the customer portal.
import type { ListParams } from './list';

// ---- Test clocks ----------------------------------------------------------------

export const TEST_CLOCK_STATUSES = ['ready', 'advancing', 'internal_failure'] as const;
export type TestClockStatus = (typeof TEST_CLOCK_STATUSES)[number];

/**
 * A test clock (`clock_…`, test mode only). Customers attached to it — and
 * every subscription and invoice of theirs — live at `frozen_time` instead of
 * the wall clock, so a trial, a renewal or a dunning schedule runs in seconds.
 * Advancing it runs the engine for everything on the clock up to the new time.
 */
export interface TestClock {
  id: string;
  object: 'test_helpers.test_clock';
  livemode: false;
  name: string | null;
  frozen_time: number;
  status: TestClockStatus;
  /** Deleted, with everything on it, after this instant. */
  deletes_after: number;
  created: number;
}

export interface DeletedTestClock {
  id: string;
  object: 'test_helpers.test_clock';
  deleted: true;
}

export interface CreateTestClockParams {
  frozen_time: number;
  name?: string;
}

export interface AdvanceTestClockParams {
  /** Later than the clock's current `frozen_time`. */
  frozen_time: number;
}

// ---- Billing settings ---------------------------------------------------------------

/** What dunning does to a subscription once the last retry has failed. */
export const DUNNING_FINAL_ACTIONS = ['cancel', 'unpaid', 'past_due'] as const;
export type DunningFinalAction = (typeof DUNNING_FINAL_ACTIONS)[number];

/** What happens to the invoice itself once the last retry has failed. */
export const DUNNING_INVOICE_ACTIONS = ['leave_open', 'mark_uncollectible'] as const;
export type DunningInvoiceAction = (typeof DUNNING_INVOICE_ACTIONS)[number];

/** The bounds the gateway enforces on billing settings. */
export const BILLING_SETTINGS_LIMITS = Object.freeze({
  retriesMax: 8,
  retryDaysMax: 60,
  daysUntilDueMax: 365,
  invoicePrefixPattern: '^[A-Z0-9]{3,12}$',
});

/**
 * The merchant's billing settings (one per merchant and mode). Every field has
 * a default, so a merchant that never opens the screen bills correctly:
 *
 *  - `invoice_prefix`: derived from the merchant id; numbers are
 *    `PREFIX-0001`, gapless per merchant.
 *  - `dunning.retry_schedule_days`: `[1, 3, 5, 7]` — each retry so many days
 *    after the previous attempt (16 days, four retries, Stripe's default
 *    window).
 *  - `dunning.final_action`: `cancel` — the subscription ends when the last
 *    retry fails; `dunning.invoice_action`: `mark_uncollectible`.
 *  - emails on: the payer is told when an invoice is finalized for them
 *    (`send_invoice`) and when a payment fails.
 */
export interface BillingSettings {
  object: 'billing_settings';
  livemode: boolean;
  invoice_prefix: string;
  /** The next invoice number that will be assigned. */
  next_invoice_sequence: number;
  default_days_until_due: number;
  dunning: {
    retry_schedule_days: number[];
    final_action: DunningFinalAction;
    invoice_action: DunningInvoiceAction;
  };
  emails: {
    invoice_finalized: boolean;
    payment_failed: boolean;
  };
  updated: number;
}

export interface UpdateBillingSettingsParams {
  invoice_prefix?: string;
  default_days_until_due?: number;
  dunning?: {
    retry_schedule_days?: number[];
    final_action?: DunningFinalAction;
    invoice_action?: DunningInvoiceAction;
  };
  emails?: { invoice_finalized?: boolean; payment_failed?: boolean };
}

// ---- Meters ------------------------------------------------------------------------

/** How a meter combines a period's events into the quantity billed. */
export const METER_AGGREGATIONS = ['sum', 'count', 'last'] as const;
export type MeterAggregation = (typeof METER_AGGREGATIONS)[number];

export const METER_STATUSES = ['active', 'inactive'] as const;
export type MeterStatus = (typeof METER_STATUSES)[number];

/**
 * A meter (`mtr_…`): usage events named `event_name`, attributed to a customer
 * by `customer_mapping.event_payload_key` of their payload and measured by
 * `value_settings.event_payload_key`. A metered price (`recurring.meter`)
 * bills its aggregate per period, in arrears.
 */
export interface BillingMeter {
  id: string;
  object: 'billing.meter';
  livemode: boolean;
  display_name: string;
  event_name: string;
  default_aggregation: { formula: MeterAggregation };
  customer_mapping: { type: 'by_id'; event_payload_key: string };
  value_settings: { event_payload_key: string };
  status: MeterStatus;
  created: number;
  updated: number;
}

export interface CreateBillingMeterParams {
  display_name: string;
  event_name: string;
  default_aggregation: { formula: MeterAggregation };
  /** Default `{ type: 'by_id', event_payload_key: 'peable_customer_id' }`. */
  customer_mapping?: { type: 'by_id'; event_payload_key: string };
  /** Default `{ event_payload_key: 'value' }`. */
  value_settings?: { event_payload_key: string };
}

export interface UpdateBillingMeterParams {
  display_name?: string;
}

export interface BillingMeterListParams extends ListParams {
  status?: MeterStatus;
}

/**
 * One usage event, `POST /v1/billing/meter_events`. `identifier` makes it
 * idempotent: the same identifier is the same event, forever.
 */
export interface BillingMeterEvent {
  object: 'billing.meter_event';
  livemode: boolean;
  identifier: string;
  event_name: string;
  /** The payload as received: the customer key and the value, as strings. */
  payload: Record<string, string>;
  timestamp: number;
  created: number;
}

export interface CreateBillingMeterEventParams {
  event_name: string;
  payload: Record<string, string>;
  /** Default: a fresh one — pass your own so a retry is not counted twice. */
  identifier?: string;
  /** Unix seconds; default now. At most 35 days in the past, 5 minutes in the future. */
  timestamp?: number;
}

/** `GET /v1/billing/meters/:id/event_summaries` — a customer's aggregate over a window. */
export interface BillingMeterEventSummary {
  id: string;
  object: 'billing.meter_event_summary';
  livemode: boolean;
  meter: string;
  /** The aggregate, as a base-unit-style integer string. */
  aggregated_value: string;
  start_time: number;
  end_time: number;
}

export interface BillingMeterEventSummaryParams {
  customer: string;
  start_time: number;
  end_time: number;
}

// ---- Entitlements ------------------------------------------------------------------

/** A feature (`feat_…`) a product grants — `lookup_key` is what an app checks. */
export interface EntitlementFeature {
  id: string;
  object: 'entitlements.feature';
  livemode: boolean;
  lookup_key: string;
  name: string;
  active: boolean;
  metadata: Record<string, string>;
  created: number;
}

export interface CreateEntitlementFeatureParams {
  lookup_key: string;
  name: string;
  metadata?: Record<string, string>;
}

export interface UpdateEntitlementFeatureParams {
  name?: string;
  active?: boolean;
  metadata?: Record<string, string>;
}

export interface EntitlementFeatureListParams extends ListParams {
  lookup_key?: string;
  archived?: boolean;
}

/** A feature attached to a product (`prodft_…`). */
export interface ProductFeature {
  id: string;
  object: 'product_feature';
  livemode: boolean;
  product: string;
  entitlement_feature: EntitlementFeature;
}

/**
 * One feature a customer is entitled to right now: some product granting it is
 * on a `trialing`, `active` or `past_due` subscription of theirs. Several
 * products granting the same feature give ONE entitlement — Mention Plus
 * through the Plus product or through Oxy One is the same access.
 */
export interface ActiveEntitlement {
  /** Stable per customer and feature. */
  id: string;
  object: 'entitlements.active_entitlement';
  livemode: boolean;
  feature: string;
  lookup_key: string;
}

/** What `entitlements.active_entitlement_summary.updated` carries. */
export interface ActiveEntitlementSummary {
  object: 'entitlements.active_entitlement_summary';
  livemode: boolean;
  customer: string;
  entitlements: { object: 'list'; data: ActiveEntitlement[]; has_more: false; url: string };
}

export interface ActiveEntitlementListParams extends ListParams {
  customer: string;
}

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
