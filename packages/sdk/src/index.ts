import {
  BillingNamespace,
  BillingPortalResource,
  BillingSettingsResource,
  CreditNotesResource,
  CustomerBalanceTransactionsResource,
  EntitlementsResource,
  InvoiceItemsResource,
  InvoicesResource,
  SubscriptionItemsResource,
  SubscriptionsResource,
} from './resources/billingEngine';
import { TaxResource } from './resources/tax';
export { TaxResource } from './resources/tax';
export { TaxComplianceResource } from './resources/taxCompliance';
export type {
  BillingRequestOptions,
  RetrieveFinalInvoiceAuthorityOptions,
} from './resources/billing';
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
// Server entry (`@peable.to/sdk`) — the merchant-authed SDK. Configured with a
// confidential `ApplicationCredential` (`{publicKey, secret}`), from which it
// mints and caches an Oxy service token, or with a caller-supplied
// `tokenProvider` that already holds one; exposes Stripe-ergonomics resource
// namespaces over the Gateway REST contract.
//
// Deliberately never imports `socket.io-client` or `./browser/*` — the
// server bundle stays lean and holds no browser-only code.
import {
  resolveConfig,
  PEABLE_SERVICE_AUDIENCE,
  type PeableConfig,
  type PeableWorkloadConfig,
} from './core/config';
import { createServiceTokenProvider } from './core/serviceToken';
import { createRestClient } from './core/client';
import { PaymentIntentsResource } from './resources/paymentIntents';
import { PaymentLinksResource } from './resources/paymentLinks';
import { CheckoutResource } from './resources/checkoutSessions';
import { WebhooksResource } from './resources/webhooks';
import {
  EventsResource,
  WebhookDeliveriesResource,
  WebhookEndpointsResource,
} from './resources/webhookEndpoints';
import { AccountLinksResource, ConnectedAccountsResource } from './resources/connectedAccounts';
import { MerchantsResource } from './resources/merchants';
import { DisputesResource } from './resources/disputes';
import { FilesResource } from './resources/files';
import {
  PaymentMethodConfigurationsResource,
  PaymentMethodDomainsResource,
} from './resources/paymentMethodConfigurations';
import { RefundsResource } from './resources/refunds';
import { RequestLogsResource } from './resources/requestLogs';
import { TestHelpersResource } from './resources/testHelpers';
import { ChargesResource } from './resources/charges';
import { CustomersResource } from './resources/customers';
import { PaymentMethodsResource } from './resources/paymentMethods';
import { SetupIntentsResource } from './resources/setupIntents';
import { TransfersResource } from './resources/transfers';
import {
  CouponsResource,
  PricesResource,
  ProductsResource,
  PromotionCodesResource,
} from './resources/catalog';
import { AccountResource } from './resources/account';
import { BalanceResource, BalanceTransactionsResource } from './resources/balance';
import { PayoutsResource } from './resources/payouts';
import { ApplicationFeesResource } from './resources/applicationFees';
import { ReportsResource } from './resources/reports';
import { ReportingResource } from './resources/reporting';

/**
 * The merchant-authed client.
 *
 * ## Why the namespaces below are not optional extras
 *
 * This class published four: intents, links, checkout and webhooks. The gateway
 * has always served merchants, connected accounts, refunds, transfers and
 * disputes as well — so every integrator reaching those wrote their own HTTP
 * client and their own partial types for responses this package already knew.
 * Mercaria did exactly that. Two descriptions of one wire format, in two
 * repositories, with nothing comparing them: a field renamed in the gateway is
 * a runtime failure over there, found by a settlement that does not happen.
 *
 * An SDK that covers less than the API it wraps does not reduce surface, it
 * relocates it.
 */
export class Peable {
  /** Release requester-bound shared transport resources after the operation. */
  readonly dispose: () => void;
  /**
   * The Stripe-Billing proxy (`/v1/billing/*`), plus the native engine's
   * usage meters: `billing.meters`, `billing.meterEvents` (ADR 0018).
   */
  readonly billing: BillingNamespace;
  /** Peable Tax: location evidence, calculations, and what was collected. */
  readonly tax: TaxResource;
  readonly paymentIntents: PaymentIntentsResource;
  readonly paymentLinks: PaymentLinksResource;
  readonly checkout: CheckoutResource;
  /** Verify a delivery: `constructEvent(rawBody, signatureHeader, secret)`. */
  readonly webhooks: WebhooksResource;
  /** Where events are sent: `we_…` endpoints, each with its own events and secret. */
  readonly webhookEndpoints: WebhookEndpointsResource;
  /** Every event of the last 30 days (`evt_…`). */
  readonly events: EventsResource;
  /** Your own API requests of the last 30 days, and their live tail (test mode). */
  readonly requestLogs: RequestLogsResource;
  /** Test mode only: drive a test object as a payer, the chain or the clock would. */
  readonly testHelpers: TestHelpersResource;
  /** One row per event per endpoint, and redelivery. */
  readonly webhookDeliveries: WebhookDeliveriesResource;
  /** The merchant this credential speaks for. Resolved from the credential. */
  readonly merchants: MerchantsResource;
  /** Sellers a marketplace onboards, and their readiness. */
  readonly connectedAccounts: ConnectedAccountsResource;
  /**
   * The same sellers, Stripe-named: `accounts.create/retrieve/list` is
   * `connectedAccounts.create/retrieve/list` — one resource, two names, so a
   * Stripe Connect integration reads the way its authors expect.
   */
  readonly accounts: ConnectedAccountsResource;
  /**
   * Onboarding links, Stripe-named: `accountLinks.create({ account, rail, … })`
   * for a seller, or without `account` for the merchant's own fiat account.
   */
  readonly accountLinks: AccountLinksResource;
  /** The merchant's own fiat account (ADR 0015 §1): readiness, requirements, payout schedule. */
  readonly account: AccountResource;
  /** Available, pending and informational funds, per currency — a mirror of the provider. */
  readonly balance: BalanceResource;
  /** Every movement of the balance (`txn_…`). */
  readonly balanceTransactions: BalanceTransactionsResource;
  /** The provider paying the balance out to the merchant's bank (`po_…`). */
  readonly payouts: PayoutsResource;
  /** Read-only: Orbit's fee taken on a payment (`fee_…`). */
  readonly applicationFees: ApplicationFeesResource;
  /** Ledger reports: `payoutReconciliation({ payout })`. */
  readonly reports: ReportsResource;
  /** Report runs (`reportRuns`) and the report types they run (`reportTypes`). */
  readonly reporting: ReportingResource;
  /** Money going back to a payer. */
  readonly refunds: RefundsResource;
  /** Read-only: the authorization a card payment obtained (`ch_…`). */
  readonly charges: ChargesResource;
  /** Customers (`cus_…`, ADR 0016). */
  readonly customers: CustomersResource;
  /** A customer's saved cards (`pm_…`), born attached by a SetupIntent. */
  readonly paymentMethods: PaymentMethodsResource;
  /** Saving a card for later without charging it (`seti_…`). */
  readonly setupIntents: SetupIntentsResource;
  /** Money going out to a seller, and coming back from one. */
  readonly transfers: TransfersResource;
  /** The network opens these: stage evidence, submit it once, or accept (`close`). */
  readonly disputes: DisputesResource;
  /** The catalog: what you sell (`prod_…`) — archive with `active: false`. */
  readonly products: ProductsResource;
  /** How much a product costs (`price_…`) — immutable amounts; archive and replace. */
  readonly prices: PricesResource;
  /** Discounts by percentage or fixed amount. */
  readonly coupons: CouponsResource;
  /** Customer-facing codes (`promo_…`) that redeem a coupon. */
  readonly promotionCodes: PromotionCodesResource;
  /** Files (`file_…`) for one purpose: dispute evidence, a business logo, verification documents. */
  readonly files: FilesResource;
  /** Which card-rail methods payers are offered (`pmc_…`). */
  readonly paymentMethodConfigurations: PaymentMethodConfigurationsResource;
  /** Web domains wallets (Apple Pay, Google Pay) may run on (`pmd_…`). */
  readonly paymentMethodDomains: PaymentMethodDomainsResource;
  /** The native billing engine (ADR 0018): subscriptions (`sub_…`). */
  readonly subscriptions: SubscriptionsResource;
  /** A subscription's items (`si_…`). */
  readonly subscriptionItems: SubscriptionItemsResource;
  /** Invoices (`in_…`): finalize, pay, send, void, preview the upcoming one. */
  readonly invoices: InvoicesResource;
  /** Invoice items (`ii_…`) — pending on a customer, or on a draft. */
  readonly invoiceItems: InvoiceItemsResource;
  /** Credit notes (`cn_…`). */
  readonly creditNotes: CreditNotesResource;
  /** A customer's balance ledger (`cbtxn_…`). */
  readonly customerBalanceTransactions: CustomerBalanceTransactionsResource;
  /** Invoice numbering and dunning. */
  readonly billingSettings: BillingSettingsResource;
  /** Features, what grants them, and what a customer may access now. */
  readonly entitlements: EntitlementsResource;
  /** The Orbit-hosted customer portal: configurations and sessions. */
  readonly billingPortal: BillingPortalResource;

  constructor(config: PeableConfig) {
    const resolved = resolveConfig(config);
    const transport = config.oxy?.createServiceClient({
      baseURL: resolved.baseURL,
      audience: PEABLE_SERVICE_AUDIENCE,
      ...(config.requester ? { requester: { ...config.requester } } : {}),
    });
    const tokenProvider = config.oxy
      ? undefined
      : (config.tokenProvider ?? createServiceTokenProvider(config));
    this.dispose = () => transport?.dispose();
    const client = createRestClient(
      { baseURL: resolved.baseURL, requestTimeoutMs: resolved.requestTimeoutMs },
      tokenProvider,
      transport ? { fetch: transport.fetch } : {},
    );

    this.billing = new BillingNamespace(
      client,
      resolved.invoiceAuthorityKeys,
      resolved.taxQuoteAuthorityKeys,
    );
    this.tax = new TaxResource(client);
    this.paymentIntents = new PaymentIntentsResource(client);
    this.paymentLinks = new PaymentLinksResource(client);
    this.checkout = new CheckoutResource(client);
    this.webhooks = new WebhooksResource();
    this.webhookEndpoints = new WebhookEndpointsResource(client);
    this.events = new EventsResource(client);
    this.requestLogs = new RequestLogsResource(client);
    this.testHelpers = new TestHelpersResource(client);
    this.webhookDeliveries = new WebhookDeliveriesResource(client);
    this.merchants = new MerchantsResource(client);
    this.connectedAccounts = new ConnectedAccountsResource(client);
    this.accounts = this.connectedAccounts;
    this.account = new AccountResource(client);
    this.accountLinks = new AccountLinksResource(this.connectedAccounts, this.account);
    this.balance = new BalanceResource(client);
    this.balanceTransactions = new BalanceTransactionsResource(client);
    this.payouts = new PayoutsResource(client);
    this.applicationFees = new ApplicationFeesResource(client);
    this.reports = new ReportsResource(client);
    this.reporting = new ReportingResource(client);
    this.refunds = new RefundsResource(client);
    this.charges = new ChargesResource(client);
    this.customers = new CustomersResource(client);
    this.paymentMethods = new PaymentMethodsResource(client);
    this.setupIntents = new SetupIntentsResource(client);
    this.transfers = new TransfersResource(client);
    this.disputes = new DisputesResource(client);
    this.products = new ProductsResource(client);
    this.prices = new PricesResource(client);
    this.coupons = new CouponsResource(client);
    this.promotionCodes = new PromotionCodesResource(client);
    this.files = new FilesResource(client);
    this.paymentMethodConfigurations = new PaymentMethodConfigurationsResource(client);
    this.paymentMethodDomains = new PaymentMethodDomainsResource(client);
    this.subscriptions = new SubscriptionsResource(client);
    this.subscriptionItems = new SubscriptionItemsResource(client);
    this.invoices = new InvoicesResource(client);
    this.invoiceItems = new InvoiceItemsResource(client);
    this.creditNotes = new CreditNotesResource(client);
    this.customerBalanceTransactions = new CustomerBalanceTransactionsResource(client);
    this.billingSettings = new BillingSettingsResource(client);
    this.entitlements = new EntitlementsResource(client);
    this.billingPortal = new BillingPortalResource(client);
  }
}

export type {
  PeableConfig,
  PeableCredentialConfig,
  PeableTokenProviderConfig,
  ResolvedPeableConfig,
} from './core/config';
export { DEFAULT_GATEWAY_BASE_URL, DEFAULT_OXY_API_URL } from './core/config';

export {
  PeableError,
  PeableAuthenticationError,
  PeableInvalidRequestError,
  PeablePermissionError,
  PeableApiError,
  PeableCardError,
  PeableSignatureVerificationError,
} from './core/errors';
export type { PeableErrorType, PeableErrorDetails } from './core/errors';

export type {
  DownloadedBytes,
  GatewayClient,
  PeableRequestOptions,
  RestClient,
  RestClientRequestOptions,
  RestClientStreamOptions,
} from './core/client';
export type { LiveStreamOptions } from './core/liveStream';
export { RequestLogsResource } from './resources/requestLogs';
export type { RequestLogStreamParams } from './resources/requestLogs';
export { TestHelpersResource } from './resources/testHelpers';
export type {
  RequestLog,
  RequestLogListParams,
  RequestLogMethod,
  RequestLogStatusFilter,
  SimulatedFaircoinOutcome,
  SimulateFaircoinPaymentParams,
} from '@peable.to/shared-types';
export type { ServiceTokenProvider } from './core/serviceToken';

export type {
  CreateCheckoutSessionOptions,
  CheckoutSessionList,
  CheckoutSessionListParams,
  CheckoutLineItemList,
  CheckoutLineItemListParams,
} from './resources/checkoutSessions';
export { CheckoutResource, CheckoutSessionsResource } from './resources/checkoutSessions';
export type {
  CreatePaymentIntentOptions,
  PaymentIntentClientAction,
  PaymentIntentListParams,
  PaymentIntentList,
} from './resources/paymentIntents';
export type {
  AccountLink,
  AccountLinkParams,
  ConnectedAccountList,
  ConnectedAccountListParams,
  CreateAccountLinkParams,
  CreateConnectedAccountParams,
} from './resources/connectedAccounts';
export { AccountLinksResource, ConnectedAccountsResource } from './resources/connectedAccounts';
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
export type { RegisterMerchantParams, UpdateMerchantParams } from './resources/merchants';
export { DisputesResource } from './resources/disputes';
export type { DisputeList, DisputeListParams } from './resources/disputes';
export { FilesResource } from './resources/files';
export type {
  CreateFileParams,
  CreateFileUploadParams,
  FileList,
  FileListParams,
} from './resources/files';
export {
  PaymentMethodConfigurationsResource,
  PaymentMethodDomainsResource,
} from './resources/paymentMethodConfigurations';
export type {
  PaymentMethodConfigurationList,
  PaymentMethodDomainList,
  PaymentMethodDomainListParams,
} from './resources/paymentMethodConfigurations';
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
  CreateRefundParams,
  RefundList,
  RefundListParams,
  UpdateRefundParams,
} from './resources/refunds';
export type {
  Refund,
  RefundOrigin,
  RefundReason,
  RefundStatus,
  AccountRequirements,
} from '@peable.to/shared-types';
export { REFUND_REASONS } from '@peable.to/shared-types';
export { AccountResource } from './resources/account';
export type { CreateMerchantAccountLinkParams } from './resources/account';
export { BalanceResource, BalanceTransactionsResource } from './resources/balance';
export type { BalanceTransactionList, BalanceTransactionListParams } from './resources/balance';
export { PayoutsResource } from './resources/payouts';
export type { PayoutList, PayoutListParams } from './resources/payouts';
export { ApplicationFeesResource } from './resources/applicationFees';
export type {
  ApplicationFeeList,
  ApplicationFeeListParams,
  FeeRefundList,
} from './resources/applicationFees';
export { ReportsResource } from './resources/reports';
export type { PayoutReconciliationParams } from './resources/reports';
export {
  ReportingResource,
  ReportRunsResource,
  ReportTypesResource,
} from './resources/reporting';
export type {
  ReportRunList,
  ReportRunListParams,
  ReportTypeList,
} from './resources/reporting';
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
export type { ApiSearchPromise, AutoPaging } from './core/list';
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
export {
  MerchantBrandingResource,
  MerchantEmailSettingsResource,
  MerchantsResource,
} from './resources/merchants';
export { ChargesResource } from './resources/charges';
export type { ChargeList, ChargeListParams } from './resources/charges';
export type {
  BillingDetails,
  CancelSetupIntentParams,
  CardDetails,
  CreateCustomerParams,
  CreateSetupIntentParams,
  Customer,
  DeletedCustomer,
  PaymentMethod,
  SetupIntent,
  SetupIntentStatus,
  UpdateCustomerParams,
  UpdatePaymentMethodParams,
} from '@peable.to/shared-types';
export { CustomersResource } from './resources/customers';
export type { CustomerList, CustomerListParams } from './resources/customers';
export { PaymentMethodsResource } from './resources/paymentMethods';
export type { PaymentMethodList, PaymentMethodListParams } from './resources/paymentMethods';
export { SetupIntentsResource } from './resources/setupIntents';
export type { SetupIntentList, SetupIntentListParams } from './resources/setupIntents';
export type {
  CreateTransferParams,
  ReverseTransferParams,
  TransferList,
} from './resources/transfers';
export type {
  CreatePaymentLinkOptions,
  PaymentLinkLineItemList,
  PaymentLinkListParams,
  PaymentLinkList,
  UpdatePaymentLinkParams,
} from './resources/paymentLinks';
export { PaymentLinksResource } from './resources/paymentLinks';
export { WEBHOOK_SIGNATURE_HEADER, WebhooksResource } from './resources/webhooks';
export {
  EventsResource,
  WebhookDeliveriesResource,
  WebhookEndpointsResource,
} from './resources/webhookEndpoints';
export type {
  EventListParams,
  EventStreamParams,
  WebhookDeliveryListParams,
} from './resources/webhookEndpoints';
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
export type { ConstructEventOptions } from './resources/webhooks';
export {
  CouponsResource,
  PricesResource,
  ProductsResource,
  PromotionCodesResource,
} from './resources/catalog';
export type { CatalogCreateOptions } from './resources/catalog';
export {
  ActiveEntitlementsResource,
  BillingMeterEventsResource,
  BillingMetersResource,
  BillingNamespace,
  BillingPortalConfigurationsResource,
  BillingPortalResource,
  BillingPortalSessionsResource,
  BillingSettingsResource,
  CreditNotesResource,
  CustomerBalanceTransactionsResource,
  EntitlementFeaturesResource,
  EntitlementsResource,
  InvoiceItemsResource,
  InvoicesResource,
  ProductFeaturesResource,
  SubscriptionItemsResource,
  SubscriptionsResource,
  TestClocksResource,
} from './resources/billingEngine';
export type { BillingCreateOptions } from './resources/billingEngine';
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
export { ContributionsResource } from './resources/contributions';
export type {
  ContributionScope,
  CreateContribution,
  ContributionLink,
  ContributionDetails,
} from './resources/contributions';

export type { BillingFaircoinFxQuote } from '@peable.to/shared-types';

/** Own applications use this factory with their existing shared OxyServer. */
export function peableForOxyService(config: PeableWorkloadConfig): Peable {
  return new Peable(config);
}
export { PEABLE_SERVICE_AUDIENCE } from './core/config';
export type { PeableWorkloadConfig, PeableOxyHost, PeableRequester } from './core/config';
