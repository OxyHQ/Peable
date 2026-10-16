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
  providerCustomerId: string;
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
  providerPriceId: string;
  planId: string;
  interval: 'month' | 'year';
  currency: string;
  grossMinorUnits: number;
  taxTreatment: 'inclusive' | 'exclusive';
}
export interface BillingRailOption {
  rail: BillingRail;
  settlement: BillingRailSettlement;
  /** The rail a request that names none is served by: the first configured. */
  default: boolean;
  /** Whether `createTaxQuote` is answered for this rail. */
  taxQuotes: boolean;
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
  storeId: string;
  storeName: string;
  /** The payer's chosen rail. Omitted: the merchant's default rail. A customer
   * belongs to one rail, and its checkouts and subscriptions follow it. */
  rail?: BillingRail;
}
export interface CreateBillingCheckoutParams {
  /** Optional assertion of the rail; it must be the rail of `providerCustomerId`. */
  rail?: BillingRail;
  /** Opt-in fiscal checkout. The full signed quote is immutable and single-use.
   * Requires a trusted Peable adapter capable of applying these exact amounts. */
  taxQuote?: BillingTaxQuote;
  providerCustomerId: string;
  providerPriceId: string;
  trialDays: number;
  returnUrl: string;
  storeId: string;
  planId: string;
}
export interface CreateBillingPortalParams {
  providerCustomerId: string;
  returnUrl: string;
}
/** Sensitive owner-only URL. The gateway refuses replay after expiresAt. */
export interface BillingHostedSession {
  url: string;
  expiresAt: string;
}
/** Provider observations only. Consumers own plan/status/entitlement interpretation. */
export interface BillingSubscription {
  providerSubscriptionId: string;
  /** Discovery only; invoice must still be read and proven paid. */
  latestInvoiceId?: string | null;
  providerCustomerId: string;
  providerPriceId: string;
  storeId: string;
  planId: string;
  livemode: boolean;
  status: BillingSubscriptionStatus;
  interval: 'month' | 'year';
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  cancelAt: string | null;
  cancelledAt: string | null;
}

/** Owned recurring checkout correlation; completing checkout is not paid evidence. */
export interface BillingCheckoutSession extends BillingHostedSession {
  id: string;
}
export interface BillingCheckoutObservation {
  /** Immutable subscription_create invoice proven for this exact checkout. Discovery only, never paid authority. */
  initialInvoiceId: string | null;
  id: string;
  status: 'open' | 'complete' | 'expired';
  storeId: string;
  planId: string;
  providerCustomerId: string;
  providerPriceId: string;
  subscription: BillingSubscription | null;
}
/** Authenticated authoritative read, one settled full non-prorated line only.
 * Tax figures are provider observations, not a tax quote or seller configuration. */
export interface BillingInvoiceState extends BillingPaidInvoice {
  chargeId: string;
  amountRefunded: string;
  state: 'paid' | 'fully_refunded' | 'partially_refunded';
}
export interface BillingPaidInvoice {
  invoiceId: string;
  lineId: string;
  paymentIntentId: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerPriceId: string;
  storeId: string;
  planId: string;
  livemode: boolean;
  currency: string;
  amountPaid: string;
  netAmount: string | null;
  taxAmount: string | null;
  periodStart: string;
  periodEnd: string;
  paidAt: string;
  observedAt: string;
}

/** Provider-independent fiscal evidence. Values come from the configured authority,
 * never from invoice amounts, merchant metadata, or an application tax guess. */
export interface BillingInvoiceAuthoritySource {
  invoiceId: string;
  paymentIntentId: string;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  planId: string;
  merchantId: string;
  appId: string;
  mode: 'test' | 'live';
  environment: 'development' | 'staging' | 'production';
}
export interface BillingFinalInvoice {
  platform: 'peable';
  currency: string;
  grossMinorUnits: number;
  netMinorUnits: number;
  taxMinorUnits: number;
  merchantFeeMinorUnits: number;
  taxTreatment: 'inclusive' | 'exclusive';
  sellerId: string;
  invoiceIssuerId: string;
  taxQuoteId: string;
  customerLocationEvidenceId: string;
  taxRateEvidenceId: string;
  context: {
    payerAccountId: string;
    beneficiaryAccountId: string;
    providerSubscriptionId: string;
    offerId: string;
    offerVersion: number;
    periodStart: string;
    periodEnd: string;
    mode: 'test' | 'live';
    environment: 'development' | 'staging' | 'production';
  };
  issuedAt: string;
  expiresAt: string;
  faircoinQuote?: {
    id: string;
    amountBaseUnits: string;
    quotedAt: string;
    expiresAt: string;
    roundingEvidenceId: string;
  };
}
export interface BillingFinalInvoiceAuthority {
  schemaVersion: 1;
  source: BillingInvoiceAuthoritySource;
  invoice: BillingFinalInvoice;
  method: 'card' | 'faircoin';
  /** Versioned canonical payload: source, invoice and method after strict schema parsing. */
  signature: { algorithm: 'Ed25519'; keyId: string; value: string };
}

/** An automatic renewal authorization is an explicit, bounded instruction.
 * Transporting it does not create a mandate or authorize custody of payer keys. */
export type BillingFaircoinRenewalChoice =
  | { method: 'faircoin'; renewal: 'manual_monthly' }
  | { method: 'faircoin'; renewal: 'automatic'; consent: BillingFaircoinRenewalConsent };
export interface BillingFaircoinRenewalConsent {
  authorizationId: string;
  payerAccountId: string;
  merchantId: string;
  appId: string;
  subscriptionId: string;
  planId: string;
  mode: 'test' | 'live';
  environment: 'development' | 'staging' | 'production';
  explicitConsent: true;
  consentEvidenceId: string;
  maximumAmountBaseUnits: string;
  interval: 'month';
  intervalCount: 1;
  startsAt: string;
  expiresAt: string;
  acceptedAt: string;
}
export interface BillingFaircoinRenewalRevocation {
  authorizationId: string;
  revokedAt: string;
  revocationEvidenceId: string;
}

/** A merchant asks Peable to quote a registered product. Monetary/fiscal
 * configuration is resolved inside Peable, never supplied by a consumer. */
export interface CreateBillingTaxQuoteParams {
  /** Omitted: the first of the merchant's rails that answers tax quotes. */
  rail?: BillingRail;
  storeId: string;
  planId: string;
  customerLocationEvidenceId: string;
}
export interface BillingTaxQuote {
  schemaVersion: 1;
  source: {
    merchantId: string;
    appId: string;
    storeId: string;
    planId: string;
    mode: 'test' | 'live';
    environment: 'development' | 'staging' | 'production';
  };
  quote: {
    id: string;
    currency: string;
    grossMinorUnits: number;
    netMinorUnits: number;
    taxMinorUnits: number;
    taxTreatment: 'inclusive' | 'exclusive';
    sellerId: string;
    invoiceIssuerId: string;
    taxRemitterId: string;
    taxServiceRef: string;
    country: string;
    coverageEvidenceId: string;
    taxRateEvidenceId: string;
    customerLocationEvidenceId: string;
    quotedAt: string;
    expiresAt: string;
  };
  signature: { algorithm: 'Ed25519'; keyId: string; value: string };
}

/** Read-only recovery of one previously attempted recurring checkout. Neither
 * absence nor uncertainty permits cancellation or another financial operation. */
export interface RetrieveBillingCheckoutOperationParams {
  idempotencyKey: string;
  providerCustomerId: string;
  providerPriceId: string;
  storeId: string;
  planId: string;
}
export interface BillingCheckoutOperationSource extends RetrieveBillingCheckoutOperationParams {
  taxQuoteId: string | null;
  merchantId: string;
  appId: string;
  mode: 'test' | 'live';
  environment: 'development' | 'staging' | 'production';
}
export type BillingCheckoutOperationRecovery =
  | { state: 'not_found' | 'pending' | 'indeterminate'; source: BillingCheckoutOperationSource }
  | {
      state: 'succeeded';
      source: BillingCheckoutOperationSource;
      checkout: { id: string; expiresAt: string; url?: string };
    };

export interface BillingFaircoinFxQuote {
  id: string;
  currency: 'USD';
  grossMinorUnits: number;
  amountBaseUnits: string;
  usdPerFair: string;
  source: string;
  observedAt: string;
  quotedAt: string;
  expiresAt: string;
  rounding: 'ceil_to_base_unit';
}
