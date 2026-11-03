import type { BillingInvoiceTaxLine } from './tax';

/** Recurring billing transport. Store/plan references belong to the authenticated app;
 * they do not identify an Oxy payer or convey entitlements. */
export const BILLING_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];
export interface BillingCustomer {
  provider_customer_id: string;
}

/** A settlement rail a merchant's recurring offers can be paid through. `stripe`
 * (and any further fiat provider) settles in fiat; `faircoin` settles natively
 * to the merchant's watch-only wallet. One merchant may offer several rails at
 * once and the payer chooses; every rail answers through the same subscription,
 * invoice and authority contracts below. */
export type BillingRail = 'stripe' | 'faircoin' | (string & {});
export type BillingRailSettlement = 'fiat' | 'faircoin';
/** One offer a rail can sell. Fiat provider rails bind their prices from the
 * app's own provider catalogue, so they list `offers: null`. */
export interface BillingRailOffer {
  provider_price_id: string;
  plan_id: string;
  interval: 'month' | 'year';
  currency: string;
  gross_minor_units: number;
  tax_treatment: 'inclusive' | 'exclusive';
}
export interface BillingRailOption {
  rail: BillingRail;
  settlement: BillingRailSettlement;
  /** The rail a request that names none is served by: the first configured. */
  default: boolean;
  /** Whether `createTaxQuote` is answered for this rail. */
  tax_quotes: boolean;
  /** `automatic`: the provider charges each period. `payer_initiated`: each
   * period is an explicit payment through `renewSubscription`. */
  renewal: 'automatic' | 'payer_initiated';
  offers: BillingRailOffer[] | null;
}
export interface BillingRailList {
  object: 'list';
  data: BillingRailOption[];
}
export interface EnsureBillingCustomerParams {
  store_id: string;
  store_name: string;
  /** The payer's chosen rail. Omitted: the merchant's default rail. A customer
   * belongs to one rail, and its checkouts and subscriptions follow it. */
  rail?: BillingRail;
}
export interface CreateBillingCheckoutParams {
  /** Optional assertion of the rail; it must be the rail of `providerCustomerId`. */
  rail?: BillingRail;
  /** Opt-in fiscal checkout. The full signed quote is immutable and single-use.
   * Requires a trusted Peable adapter capable of applying these exact amounts. */
  tax_quote?: BillingTaxQuote;
  provider_customer_id: string;
  provider_price_id: string;
  trial_days: number;
  return_url: string;
  store_id: string;
  plan_id: string;
}
export interface CreateBillingPortalParams {
  provider_customer_id: string;
  return_url: string;
}
/** Sensitive owner-only URL. The gateway refuses replay after expiresAt. */
export interface BillingHostedSession {
  url: string;
  expires_at: number;
}
/** Provider observations only. Consumers own plan/status/entitlement interpretation. */
export interface BillingSubscription {
  provider_subscription_id: string;
  /** Discovery only; invoice must still be read and proven paid. */
  latest_invoice_id?: string | null;
  provider_customer_id: string;
  provider_price_id: string;
  store_id: string;
  plan_id: string;
  livemode: boolean;
  status: BillingSubscriptionStatus;
  interval: 'month' | 'year';
  cancel_at_period_end: boolean;
  current_period_start: number;
  current_period_end: number;
  trial_ends_at: number | null;
  cancel_at: number | null;
  cancelled_at: number | null;
}

/** Owned recurring checkout correlation; completing checkout is not paid evidence. */
export interface BillingCheckoutSession extends BillingHostedSession {
  id: string;
}
export interface BillingCheckoutObservation {
  /** Immutable subscription_create invoice proven for this exact checkout. Discovery only, never paid authority. */
  initial_invoice_id: string | null;
  id: string;
  status: 'open' | 'complete' | 'expired';
  store_id: string;
  plan_id: string;
  provider_customer_id: string;
  provider_price_id: string;
  subscription: BillingSubscription | null;
}
/** Authenticated authoritative read, one settled full non-prorated line only.
 * Tax figures are provider observations, not a tax quote or seller configuration. */
export interface BillingInvoiceState extends BillingPaidInvoice {
  charge_id: string;
  amount_refunded: string;
  state: 'paid' | 'fully_refunded' | 'partially_refunded';
}
export interface BillingPaidInvoice {
  invoice_id: string;
  line_id: string;
  payment_intent_id: string;
  provider_subscription_id: string;
  provider_customer_id: string;
  provider_price_id: string;
  store_id: string;
  plan_id: string;
  livemode: boolean;
  currency: string;
  amount_paid: string;
  net_amount: string | null;
  tax_amount: string | null;
  period_start: number;
  period_end: number;
  paid_at: number;
  observed_at: number;
}

/** Provider-independent fiscal evidence. Values come from the configured authority,
 * never from invoice amounts, merchant metadata, or an application tax guess. */
export interface BillingInvoiceAuthoritySource {
  invoice_id: string;
  payment_intent_id: string;
  customer_id: string;
  subscription_id: string;
  price_id: string;
  plan_id: string;
  merchant_id: string;
  app_id: string;
  mode: 'test' | 'live';
  environment: 'development' | 'staging' | 'production';
}
export interface BillingFinalInvoice {
  platform: 'peable';
  currency: string;
  gross_minor_units: number;
  net_minor_units: number;
  tax_minor_units: number;
  merchant_fee_minor_units: number;
  tax_treatment: 'inclusive' | 'exclusive';
  seller_id: string;
  invoice_issuer_id: string;
  tax_quote_id: string;
  customer_location_evidence_id: string;
  tax_rate_evidence_id: string;
  context: {
    payer_account_id: string;
    beneficiary_account_id: string;
    provider_subscription_id: string;
    offer_id: string;
    offer_version: number;
    period_start: number;
    period_end: number;
    mode: 'test' | 'live';
    environment: 'development' | 'staging' | 'production';
  };
  issued_at: number;
  expires_at: number;
  faircoin_quote?: {
    id: string;
    amount_base_units: string;
    quoted_at: number;
    expires_at: number;
    rounding_evidence_id: string;
  };
  /** Present only when requested (`include: ['tax_lines']`): the frozen
   * Peable Tax lines behind `taxMinorUnits`, covered by the same signature. */
  tax_lines?: BillingInvoiceTaxLine[];
}
export interface BillingFinalInvoiceAuthority {
  schema_version: 2;
  source: BillingInvoiceAuthoritySource;
  invoice: BillingFinalInvoice;
  method: 'card' | 'faircoin';
  /** Versioned canonical payload: source, invoice and method after strict schema parsing. */
  signature: { algorithm: 'Ed25519'; key_id: string; value: string };
}

/** An automatic renewal authorization is an explicit, bounded instruction.
 * Transporting it does not create a mandate or authorize custody of payer keys. */
export type BillingFaircoinRenewalChoice =
  | { method: 'faircoin'; renewal: 'manual_monthly' }
  | { method: 'faircoin'; renewal: 'automatic'; consent: BillingFaircoinRenewalConsent };
export interface BillingFaircoinRenewalConsent {
  authorization_id: string;
  payer_account_id: string;
  merchant_id: string;
  app_id: string;
  subscription_id: string;
  plan_id: string;
  mode: 'test' | 'live';
  environment: 'development' | 'staging' | 'production';
  explicit_consent: true;
  consent_evidence_id: string;
  maximum_amount_base_units: string;
  interval: 'month';
  interval_count: 1;
  starts_at: number;
  expires_at: number;
  accepted_at: number;
}
export interface BillingFaircoinRenewalRevocation {
  authorization_id: string;
  revoked_at: number;
  revocation_evidence_id: string;
}

/** A merchant asks Peable to quote a registered product. Monetary/fiscal
 * configuration is resolved inside Peable, never supplied by a consumer. */
export interface CreateBillingTaxQuoteParams {
  /** Omitted: the first of the merchant's rails that answers tax quotes. */
  rail?: BillingRail;
  store_id: string;
  plan_id: string;
  /** Selects one offer when a plan is sold at several prices. */
  provider_price_id?: string;
  /** A `tax.location_evidence` id (`taxloc_…`) recorded for this `storeId`. */
  customer_location_evidence_id: string;
}
export interface BillingTaxQuote {
  schema_version: 2;
  source: {
    merchant_id: string;
    app_id: string;
    store_id: string;
    plan_id: string;
    mode: 'test' | 'live';
    environment: 'development' | 'staging' | 'production';
  };
  quote: {
    id: string;
    currency: string;
    gross_minor_units: number;
    net_minor_units: number;
    tax_minor_units: number;
    tax_treatment: 'inclusive' | 'exclusive';
    seller_id: string;
    invoice_issuer_id: string;
    tax_remitter_id: string;
    tax_service_ref: string;
    country: string;
    coverage_evidence_id: string;
    tax_rate_evidence_id: string;
    customer_location_evidence_id: string;
    quoted_at: number;
    expires_at: number;
  };
  signature: { algorithm: 'Ed25519'; key_id: string; value: string };
}

/** Read-only recovery of one previously attempted recurring checkout. Neither
 * absence nor uncertainty permits cancellation or another financial operation. */
export interface RetrieveBillingCheckoutOperationParams {
  idempotency_key: string;
  provider_customer_id: string;
  provider_price_id: string;
  store_id: string;
  plan_id: string;
}
export interface BillingCheckoutOperationSource extends RetrieveBillingCheckoutOperationParams {
  tax_quote_id: string | null;
  merchant_id: string;
  app_id: string;
  mode: 'test' | 'live';
  environment: 'development' | 'staging' | 'production';
}
export type BillingCheckoutOperationRecovery =
  | { state: 'not_found' | 'pending' | 'indeterminate'; source: BillingCheckoutOperationSource }
  | {
      state: 'succeeded';
      source: BillingCheckoutOperationSource;
      checkout: { id: string; expires_at: string; url?: string };
    };

export interface BillingFaircoinFxQuote {
  id: string;
  currency: 'USD';
  gross_minor_units: number;
  amount_base_units: string;
  usd_per_fair: string;
  source: string;
  observed_at: number;
  quoted_at: number;
  expires_at: number;
  rounding: 'ceil_to_base_unit';
}
