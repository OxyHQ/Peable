// Server entry (`@peable.to/sdk`) — the merchant-authed SDK. Configured with a
// confidential `ApplicationCredential` (`{publicKey, secret}`), from which it
// mints and caches an Oxy service token, with a caller-supplied `tokenProvider`
// that already holds one, or (an own Oxy workload) with the shared `OxyServer`.
//
// Every resource namespace is GENERATED from the route contracts
// (`./generated/resources.ts`, ADR 0014 D5): its methods' types are the
// contracts' own. What is written by hand is what no route describes — webhook
// verification, and the signature checks of the two signed billing documents
// (`./overlays/billingAuthority.ts`).
//
// Deliberately never imports `socket.io-client` or `./browser/*` — the server
// bundle stays lean and holds no browser-only code.

import type { BodyOf, CreateFileFromOxyParams, FileObject, RouteMap } from '@peable.to/contracts';
import {
  createRestClient,
  type GatewayClient,
  type IdempotencyOptions,
  type RequestOptions,
} from './core/client';
import {
  PEABLE_SERVICE_AUDIENCE,
  type PeableConfig,
  type PeableWorkloadConfig,
  type ResolvedPeableConfig,
  resolveConfig,
} from './core/config';
import { createServiceTokenProvider } from './core/serviceToken';
import { type FilesResource, GeneratedClient } from './generated/resources';
import { withBillingAuthority } from './overlays/billingAuthority';
import { WebhooksResource } from './resources/webhooks';

/** The gateway client a `Peable` speaks through, and how to release its transport. */
function createClient(
  config: PeableConfig,
  resolved: ResolvedPeableConfig,
): { gateway: GatewayClient; dispose: () => void } {
  const transport = config.oxy?.createServiceClient({
    baseURL: resolved.baseURL,
    audience: PEABLE_SERVICE_AUDIENCE,
    ...(config.requester ? { requester: { ...config.requester } } : {}),
  });
  const tokenProvider = config.oxy
    ? undefined
    : (config.tokenProvider ?? createServiceTokenProvider(config));
  const gateway = createRestClient(
    {
      baseURL: resolved.baseURL,
      apiVersion: resolved.apiVersion,
      ...(resolved.peableAccount === undefined ? {} : { peableAccount: resolved.peableAccount }),
      maxNetworkRetries: resolved.maxNetworkRetries,
      timeout: resolved.timeout,
    },
    tokenProvider,
    transport ? { fetch: transport.fetch } : {},
  );
  return { gateway, dispose: () => transport?.dispose() };
}

/**
 * `files`, with `create` also taking the JSON form of `POST /v1/files`:
 * `{ purpose, oxy_file }` imports an Oxy file you already own instead of
 * uploading its bytes. The route's contract documents the multipart upload;
 * the JSON form is its second schema (`createFileFromOxyParams`), which a
 * single `body` cannot name — so this one signature is widened by hand. At
 * runtime it is the generated method: params carrying bytes go as a form,
 * params without go as JSON.
 */
export interface FilesNamespace extends FilesResource {
  create(
    params: BodyOf<RouteMap['createFile']> | CreateFileFromOxyParams,
    options?: RequestOptions & IdempotencyOptions,
  ): Promise<FileObject>;
}

/**
 * The merchant-authed client: every namespace a route contract declares
 * (inherited from `GeneratedClient`), plus `webhooks`, which verifies a
 * delivery locally and is no route.
 *
 * `billing.createTaxQuote` and `billing.retrieveFinalInvoiceAuthority` verify
 * the signed document against `taxQuoteAuthorityKeys` / `invoiceAuthorityKeys`
 * before answering, and refuse to answer without them.
 */
export class Peable extends GeneratedClient {
  /** Release requester-bound shared transport resources after the operation. */
  readonly dispose: () => void;
  /** Verify a delivery: `constructEvent(rawBody, signatureHeader, secret, tolerance?)`. */
  readonly webhooks: WebhooksResource;
  declare readonly files: FilesNamespace;

  constructor(config: PeableConfig) {
    const resolved = resolveConfig(config);
    const client = createClient(config, resolved);
    super(client.gateway);
    this.dispose = client.dispose;
    this.webhooks = new WebhooksResource();
    withBillingAuthority(this.billing, {
      ...(resolved.invoiceAuthorityKeys === undefined
        ? {}
        : { invoiceAuthorityKeys: resolved.invoiceAuthorityKeys }),
      ...(resolved.taxQuoteAuthorityKeys === undefined
        ? {}
        : { taxQuoteAuthorityKeys: resolved.taxQuoteAuthorityKeys }),
    });
  }
}

/** Own applications use this factory with their existing shared OxyServer. */
export function peableForOxyService(config: PeableWorkloadConfig): Peable {
  return new Peable(config);
}

export type {
  PeableConfig,
  PeableCredentialConfig,
  PeableTokenProviderConfig,
  ResolvedPeableConfig,
  PeableWorkloadConfig,
  PeableOxyHost,
  PeableRequester,
} from './core/config';
export {
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_MAX_NETWORK_RETRIES,
  DEFAULT_OXY_API_URL,
  DEFAULT_TIMEOUT_MS,
  PEABLE_SERVICE_AUDIENCE,
} from './core/config';
export { PEABLE_API_VERSION, type PeableApiVersion } from '@peable.to/contracts/vocabulary';

export {
  PeableError,
  PeableAPIError,
  PeableAuthenticationError,
  PeableCardError,
  PeableConnectionError,
  PeableIdempotencyError,
  PeableInvalidRequestError,
  PeablePermissionError,
  PeableRateLimitError,
  PeableSignatureVerificationError,
} from './core/errors';
export type { PeableErrorType, PeableErrorDetails } from './core/errors';

export type {
  AccountOptions,
  DownloadedBytes,
  GatewayClient,
  IdempotencyOptions,
  PeableRequestOptions,
  RequestOptions,
  RestClient,
  RestClientRequestOptions,
  RestClientStreamOptions,
} from './core/client';
export type { ApiListPromise, ApiSearchPromise, AutoPaging } from './core/list';
export type { LiveStreamOptions } from './core/liveStream';
export type {
  ListPromiseOf,
  RouteKind,
  RouteSpec,
  SearchPromiseOf,
  StreamOptions,
} from './core/routeMethods';
export type { ServiceTokenProvider } from './core/serviceToken';
/** The generated namespaces (`CustomersResource`, `PaymentIntentsResource`, …). */
export type * from './generated/resources';
export type { BillingAuthorityKeys } from './overlays/billingAuthority';
export {
  DEFAULT_WEBHOOK_TOLERANCE_SEC,
  WEBHOOK_SIGNATURE_HEADER,
  WebhooksResource,
} from './resources/webhooks';

// The wire types an integration handles, re-exported so one import serves.
export type {
  CreateBillingTaxQuoteParams,
  BillingTaxQuote,
  BillingInvoiceAuthoritySource,
  BillingFinalInvoice,
  BillingFinalInvoiceAuthority,
  BillingFaircoinRenewalChoice,
  BillingFaircoinRenewalConsent,
  BillingFaircoinRenewalRevocation,
  BillingObservation,
  BillingCustomer,
  BillingHostedSession,
  BillingCheckoutSession,
  BillingEmbeddedCheckoutSession,
  BillingEmbeddedCheckoutConfiguration,
  BillingEmbeddedCheckoutBinding,
  BillingEmbeddedCheckoutAction,
  BillingEmbeddedCheckoutScope,
  BillingCheckoutObservation,
  RetrieveBillingCheckoutOperationParams,
  BillingCheckoutOperationSource,
  BillingCheckoutOperationRecovery,
  BillingPaidInvoice,
  BillingInvoiceState,
  BillingSubscription,
  CreateBillingCheckoutParams,
  CreateBillingPortalParams,
  EnsureBillingCustomerParams,
  BillingRail,
  BillingRailSettlement,
  BillingRailOffer,
  BillingRailOption,
  BillingRailList,
  BillingInvoiceTaxLine,
  TaxRegistrationScheme,
  TaxLocationEvidenceType,
  TaxBehavior,
  TaxAddress,
  TaxCode,
  TaxCalculationAccount,
  TaxSettings,
  TaxRegistration,
  TaxProductCode,
  TaxLocationEvidenceItem,
  CreateTaxLocationEvidenceParams,
  TaxLocationEvidence,
  TaxLineItemParams,
  CreateTaxCalculationParams,
  TaxBreakdownEntry,
  TaxCalculationLineItem,
  TaxCalculation,
  TaxTransaction,
  TaxTransactionList,
  ListTaxTransactionsParams,
  TaxReportRow,
  TaxReport,
} from '@peable.to/shared-types';
/** Production Peable's pinned billing-authority public keys, by key id. */
export { PEABLE_BILLING_AUTHORITY_KEYS } from '@peable.to/shared-types';
export type {
  RequestLog,
  RequestLogListParams,
  RequestLogMethod,
  RequestLogStatusFilter,
  SimulatedFaircoinOutcome,
  SimulateFaircoinPaymentParams,
} from '@peable.to/shared-types';
/**
 * The wire shapes a platform handles, re-exported so a Connect integration needs
 * one import: the seller (`ConnectedAccount` and its FairCoin half), the
 * payment, and the typed webhook event — whose `account` names the seller.
 */
export type {
  ConnectedAccount,
  ConnectedAccountFaircoin,
  ConnectedAccountFaircoinStatus,
  ConnectedAccountRail,
  CheckoutSession,
  CheckoutSessionPublic,
  CheckoutLineItem,
  CheckoutLineItemParams,
  CheckoutPriceDataParams,
  CheckoutProductDataParams,
  CheckoutCustomField,
  CheckoutCustomFieldParams,
  CheckoutCustomerDetails,
  CheckoutShippingDetails,
  CheckoutSessionMode,
  CheckoutSessionStatus,
  CheckoutSessionPaymentStatus,
  CheckoutLocale,
  CheckoutUiMode,
  CreateCheckoutSessionParams,
  UpdateCheckoutSessionParams,
  PaymentLink,
  CreatePaymentLinkParams,
  PaymentLinkLineItemParams,
  PaymentLinkAfterCompletionParams,
  MerchantBranding,
  UpdateMerchantBrandingParams,
  MerchantEmailSettings,
  UpdateMerchantEmailSettingsParams,
  CheckoutBranding,
  BrandingFont,
  BrandingBorderStyle,
  CreatePaymentIntentParams,
  CancelPaymentIntentParams,
  CapturePaymentIntentParams,
  Charge,
  ConfirmPaymentIntentParams,
  PaymentIntent,
  PaymentIntentCancellationReason,
  PaymentIntentLastPaymentError,
  PaymentIntentNextAction,
  PaymentIntentStatus,
  UpdatePaymentIntentParams,
  WebhookEvent,
  WebhookEventType,
} from '@peable.to/shared-types';
/** Whether an intent can still expire — `false` once a FairCoin payer has broadcast (ADR 0012 D9). */
export {
  canExpire,
  canStillBePaid,
  EXPIRABLE_STATUSES,
  TERMINAL_STATUSES,
} from '@peable.to/shared-types';
export type {
  CardRailPaymentMethodType,
  CreateFileFromOxyParams,
  CreatePaymentMethodConfigurationParams,
  CreatePaymentMethodDomainParams,
  Dispute,
  DisputeEvidence,
  DisputeEvidenceDetails,
  DisputeEvidenceField,
  DisputeEvidenceParams,
  DisputeFileEvidenceField,
  DisputeReason,
  DisputeStatus,
  DisputeTextEvidenceField,
  FileObject,
  FilePurpose,
  FileStatus,
  FileType,
  FileUploadPurpose,
  FiatCurrencyCode,
  PaymentMethodConfiguration,
  PaymentMethodConfigurationEntry,
  PaymentMethodConfigurationEntryParams,
  PaymentMethodConfigurationType,
  PaymentMethodDisplayPreference,
  PaymentMethodDomain,
  PaymentMethodDomainWalletStatus,
  PaymentMethodType,
  PaymentMethodUnavailableReason,
  UpdateDisputeParams,
  UpdatePaymentMethodConfigurationParams,
  UpdatePaymentMethodDomainParams,
} from '@peable.to/shared-types';
export {
  CARD_RAIL_PAYMENT_METHOD_TYPES,
  CURRENCY_CODES,
  CURRENCY_DECIMALS,
  DISPUTE_FILE_EVIDENCE_FIELDS,
  DISPUTE_REASONS,
  DISPUTE_TEXT_EVIDENCE_FIELDS,
  FIAT_CURRENCY_CODES,
  FILE_PURPOSE_POLICIES,
  FILE_PURPOSES,
  FILE_UPLOAD_PURPOSES,
  PAYMENT_METHOD_CONFIGURATION_TYPES,
  PAYMENT_METHOD_CURRENCIES,
} from '@peable.to/shared-types';
export type {
  Refund,
  RefundOrigin,
  RefundReason,
  RefundStatus,
  AccountRequirements,
} from '@peable.to/shared-types';
export { REFUND_REASONS } from '@peable.to/shared-types';
/** Reporting (Stripe's `reporting.*`). */
export {
  REPORT_RUN_STATUSES,
  REPORT_TYPE_IDS,
  REPORT_TYPE_LAYOUTS,
  type CreateReportRunParams,
  type ListReportRunsParams,
  type ReportRun,
  type ReportRunParameters,
  type ReportRunStatus,
  type ReportType,
  type ReportTypeId,
} from '@peable.to/shared-types';
/** Search (Stripe's Search API): `<resource>.search({ query })`. */
export {
  SEARCHABLE_RESOURCES,
  SEARCH_QUERY_MAX_CLAUSES,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_SUBSTRING_MIN_LENGTH,
  type SearchParams,
  type SearchResult,
  type SearchableResource,
} from '@peable.to/shared-types';
/** The money wire shapes (ADR 0015): the account, the balance and its ledger, payouts, fees. */
export type {
  Account,
  AccountBusinessProfile,
  AccountCapabilityStatus,
  AccountPayoutSchedule,
  AccountSettings,
  AccountType,
  ApplicationFee,
  Balance,
  BalanceAmount,
  BalanceTransaction,
  BalanceTransactionFeeDetail,
  BalanceTransactionStatus,
  BalanceTransactionType,
  CreatePayoutParams,
  FeeRefund,
  ListBalanceTransactionsParams,
  ListPayoutsParams,
  Payout,
  PayoutInterval,
  PayoutReconciliationReport,
  PayoutStatus,
  PayoutWeeklyAnchor,
  PaymentIntentTransferData,
  ReconciliationMismatch,
  ReconciliationMismatchKind,
  UpdateAccountParams,
} from '@peable.to/shared-types';
export {
  BALANCE_TRANSACTION_STATUSES,
  BALANCE_TRANSACTION_TYPES,
  PAYOUT_INTERVALS,
  PAYOUT_STATUSES,
  PAYOUT_WEEKLY_ANCHORS,
  RECONCILIATION_MISMATCH_KINDS,
} from '@peable.to/shared-types';
export type {
  BillingDetails,
  CancelSetupIntentParams,
  CardDetails,
  CreateCustomerParams,
  CreateSetupIntentParams,
  Customer,
  DeletedCustomer,
  DetachPaymentMethodParams,
  ListCustomersParams,
  ListPaymentMethodsParams,
  PaymentMethod,
  SetupIntent,
  SetupIntentStatus,
  UpdateCustomerParams,
  UpdatePaymentMethodParams,
} from '@peable.to/shared-types';
export type {
  CreateWebhookEndpointParams,
  DeletedWebhookEndpoint,
  RollWebhookEndpointSecretParams,
  UpdateWebhookEndpointParams,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEnabledEvent,
  WebhookEndpoint,
  WebhookEndpointDisabledReason,
  WebhookEndpointStatus,
  WebhookEventRequest,
} from '@peable.to/shared-types';
/** The native billing engine's wire objects and parameters (ADR 0018). */
export type {
  ActiveEntitlement,
  ActiveEntitlementListParams,
  ActiveEntitlementSummary,
  AdvanceTestClockParams,
  AutomaticTaxStatus,
  BillingMeter,
  BillingMeterEvent,
  BillingMeterEventSummary,
  BillingMeterEventSummaryParams,
  BillingMeterListParams,
  BillingPortalConfiguration,
  BillingPortalConfigurationListParams,
  BillingPortalFeatures,
  BillingPortalSession,
  BillingSettings,
  CancelSubscriptionParams,
  CollectionMethod,
  CreateBillingMeterEventParams,
  CreateBillingMeterParams,
  CreateBillingPortalConfigurationParams,
  CreateBillingPortalSessionParams,
  CreateCreditNoteParams,
  CreateCustomerBalanceTransactionParams,
  CreateEntitlementFeatureParams,
  CreateInvoiceItemParams,
  CreateInvoiceParams,
  CreateSubscriptionItemParams,
  CreateSubscriptionParams,
  CreateTestClockParams,
  CreditNote,
  CreditNoteLineItem,
  CreditNoteListParams,
  CreditNoteReason,
  CustomerBalanceTransaction,
  DeletedInvoice,
  DeletedInvoiceItem,
  DeletedSubscriptionItem,
  DeletedTestClock,
  DeleteSubscriptionItemParams,
  Discount,
  DiscountParams,
  DunningFinalAction,
  EntitlementFeature,
  EntitlementFeatureListParams,
  FinalizeInvoiceParams,
  Invoice,
  InvoiceBillingReason,
  InvoiceItem,
  InvoiceItemListParams,
  InvoiceLineItem,
  InvoiceListParams,
  InvoiceStatus,
  MeterAggregation,
  PauseCollectionBehavior,
  PayInvoiceParams,
  PaymentBehavior,
  ProductFeature,
  ProrationBehavior,
  PublicInvoice,
  PublicPortalSession,
  ResumeSubscriptionParams,
  Subscription,
  SubscriptionItem,
  SubscriptionItemListParams,
  SubscriptionListParams,
  SubscriptionStatus,
  TestClock,
  UpcomingInvoiceParams,
  UpdateBillingMeterParams,
  UpdateBillingPortalConfigurationParams,
  UpdateBillingSettingsParams,
  UpdateEntitlementFeatureParams,
  UpdateInvoiceItemParams,
  UpdateInvoiceParams,
  UpdateSubscriptionItemParams,
  UpdateSubscriptionParams,
} from '@peable.to/shared-types';
/** The catalog's wire objects and parameters (ADR 0018). */
export type {
  Coupon,
  CouponDuration,
  CouponListParams,
  CreateCouponParams,
  CreatePriceParams,
  CreateProductParams,
  CreatePromotionCodeParams,
  DefaultPriceDataParams,
  DeletedCoupon,
  DeletedProduct,
  Price,
  PriceBillingScheme,
  PriceDataParams,
  PriceListParams,
  PriceRecurring,
  PriceTaxBehavior,
  PriceTier,
  PriceTierParams,
  PriceTiersMode,
  PriceTransformQuantity,
  PriceType,
  Product,
  ProductListParams,
  ProductMarketingFeature,
  PromotionCode,
  PromotionCodeListParams,
  PromotionCodeRestrictions,
  RecurringInterval,
  RecurringParams,
  RecurringUsageType,
  TransformQuantityRound,
  UpdateCouponParams,
  UpdatePriceParams,
  UpdateProductParams,
  UpdatePromotionCodeParams,
} from '@peable.to/shared-types';
export type { BillingFaircoinFxQuote } from '@peable.to/shared-types';
