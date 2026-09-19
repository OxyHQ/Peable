// Server entry (`@peable.to/sdk`) — the merchant-authed SDK. Configured with a
// confidential `ApplicationCredential` (`{publicKey, secret}`); mints and
// caches an Oxy service token, and exposes Stripe-ergonomics resource
// namespaces over the Gateway REST contract.
//
// Deliberately never imports `socket.io-client` or `./browser/*` — the
// server bundle stays lean and holds no browser-only code.
import { resolveConfig, type PeableConfig } from './core/config';
import { createServiceTokenProvider } from './core/serviceToken';
import { createRestClient } from './core/client';
import { PaymentIntentsResource } from './resources/paymentIntents';
import { PaymentLinksResource } from './resources/paymentLinks';
import { CheckoutResource } from './resources/checkoutSessions';
import { WebhooksResource } from './resources/webhooks';
import { ConnectedAccountsResource } from './resources/connectedAccounts';
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
  readonly paymentIntents: PaymentIntentsResource;
  readonly paymentLinks: PaymentLinksResource;
  readonly checkout: CheckoutResource;
  readonly webhooks: WebhooksResource;
  /** The merchant this credential speaks for. Resolved from the credential. */
  readonly merchants: MerchantsResource;
  /** Sellers a marketplace onboards, and their readiness. */
  readonly connectedAccounts: ConnectedAccountsResource;
  /** Money going back to a payer. */
  readonly refunds: RefundsResource;
  /** Money going out to a seller, and coming back from one. */
  readonly transfers: TransfersResource;
  /** Read-only: the network initiates these. */
  readonly disputes: DisputesResource;

  constructor(config: PeableConfig) {
    const resolved = resolveConfig(config);
    const tokenProvider = createServiceTokenProvider(config);
    const client = createRestClient({ baseURL: resolved.baseURL }, tokenProvider);

    this.paymentIntents = new PaymentIntentsResource(client);
    this.paymentLinks = new PaymentLinksResource(client);
    this.checkout = new CheckoutResource(client);
    this.webhooks = new WebhooksResource();
    this.merchants = new MerchantsResource(client);
    this.connectedAccounts = new ConnectedAccountsResource(client);
    this.refunds = new RefundsResource(client);
    this.transfers = new TransfersResource(client);
    this.disputes = new DisputesResource(client);
  }
}

export type { PeableConfig, ResolvedPeableConfig } from './core/config';
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
  CreateConnectedAccountParams,
} from './resources/connectedAccounts';
export type {
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
export { WEBHOOK_SIGNATURE_HEADER } from './resources/webhooks';
export type { ConstructEventOptions } from './resources/webhooks';
