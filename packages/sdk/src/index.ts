import { BillingResource } from './resources/billing';
import { TaxResource } from './resources/tax';
export { TaxResource } from './resources/tax';
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
import { AccountLinksResource, ConnectedAccountsResource } from './resources/connectedAccounts';
import { DisputesResource, MerchantsResource } from './resources/merchants';
import { RefundsResource } from './resources/refunds';
import { TransfersResource } from './resources/transfers';

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
  readonly billing: BillingResource;
  /** Peable Tax: location evidence, calculations, and what was collected. */
  readonly tax: TaxResource;
  readonly paymentIntents: PaymentIntentsResource;
  readonly paymentLinks: PaymentLinksResource;
  readonly checkout: CheckoutResource;
  readonly webhooks: WebhooksResource;
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
  /** Onboarding links, Stripe-named: `accountLinks.create({ account, rail, … })`. */
  readonly accountLinks: AccountLinksResource;
  /** Money going back to a payer. */
  readonly refunds: RefundsResource;
  /** Money going out to a seller, and coming back from one. */
  readonly transfers: TransfersResource;
  /** Read-only: the network initiates these. */
  readonly disputes: DisputesResource;

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

    this.billing = new BillingResource(
      client,
      resolved.invoiceAuthorityKeys,
      resolved.taxQuoteAuthorityKeys,
    );
    this.tax = new TaxResource(client);
    this.paymentIntents = new PaymentIntentsResource(client);
    this.paymentLinks = new PaymentLinksResource(client);
    this.checkout = new CheckoutResource(client);
    this.webhooks = new WebhooksResource();
    this.merchants = new MerchantsResource(client);
    this.connectedAccounts = new ConnectedAccountsResource(client);
    this.accounts = this.connectedAccounts;
    this.accountLinks = new AccountLinksResource(this.connectedAccounts);
    this.refunds = new RefundsResource(client);
    this.transfers = new TransfersResource(client);
    this.disputes = new DisputesResource(client);
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
  PeableSignatureVerificationError,
} from './core/errors';
export type { PeableErrorType, PeableErrorDetails } from './core/errors';

export type { RestClient, RestClientRequestOptions } from './core/client';
export type { ServiceTokenProvider } from './core/serviceToken';

export type { CreateCheckoutSessionOptions } from './resources/checkoutSessions';
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
  CreateCheckoutSessionParams,
  CreatePaymentIntentParams,
  PaymentIntent,
  PaymentIntentStatus,
  WebhookEvent,
  WebhookEventType,
} from '@peable.to/shared-types';
/** Whether an intent can still expire — `false` once a FairCoin payer has broadcast (ADR 0012 D9). */
export { canExpire, EXPIRABLE_STATUSES } from '@peable.to/shared-types';
export type {
  DisputeEvidenceParams,
  DisputeList,
  RegisterMerchantParams,
  UpdateMerchantParams,
} from './resources/merchants';
export type { CreateRefundParams, RefundList } from './resources/refunds';
export type {
  CreateTransferParams,
  ReverseTransferParams,
  TransferList,
} from './resources/transfers';
export type {
  PaymentLinkListParams,
  PaymentLinkList,
  UpdatePaymentLinkParams,
} from './resources/paymentLinks';
export { WEBHOOK_SIGNATURE_HEADER, WebhooksResource } from './resources/webhooks';
export type { ConstructEventOptions } from './resources/webhooks';
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
