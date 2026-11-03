import type {
  AccountLink,
  ConnectedAccount,
  List,
  ListParams,
  NetworkType,
} from '@peable.to/shared-types';
import type { PeableRequestOptions, RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';
import type { AccountResource, CreateMerchantAccountLinkParams } from './account';

/**
 * Sellers a marketplace onboards through Peable.
 *
 * The provider's own account id is not on any of these shapes, and never will
 * be (ADR 0001 D3): a merchant integrates against Peable and does not learn
 * which acquirer sits behind their seller, because the day that changes should
 * be a Peable deploy and not a merchant migration.
 *
 * Every account is addressed by the merchant's OWN reference as well as by its
 * `ca_…`. That is deliberate and it is what makes recovery possible: a create
 * whose response never arrived leaves the merchant without the `ca_…` and still
 * holding the reference they chose.
 */

/**
 * Open a seller — on the card rail, the FairCoin rail, or both — under ONE
 * `ca_…` (ADR 0012 D1). At least one half is required.
 *
 * Repeating a create converges on the seller's existing account and ADDS a half
 * it does not have yet, so a card seller can be given FairCoin later (and the
 * reverse) without a second id.
 */
export type CreateConnectedAccountParams = {
  /** The merchant's own id for this seller. The idempotency, and durable. */
  external_ref: string;
  /**
   * The FairCoin half: the chain the seller is paid on and the seller's Oxy
   * user id — the ONLY person the onboarding page lets register the key.
   * There is no key here, by design: the seller registers it themselves, in
   * their own Oxy session, through `accountLinks.create({ rail: 'faircoin' })`.
   * A non-production credential can only open `testnet`.
   */
  faircoin?: { network: NetworkType; oxy_user_id: string };
} & (
  | {
      /** ISO 3166-1 alpha-2. Case-insensitive; the gateway upper-cases it. Opens the CARD half. */
      country: string;
      business_type: 'individual' | 'company';
    }
  | { country?: undefined; business_type?: undefined }
);

/** Cursors are `ca_…` ids, resolved by the gateway inside your scope. */
export type ConnectedAccountListParams = ListParams;

export type ConnectedAccountList = List<ConnectedAccount>;

export interface AccountLinkParams {
  /** Where an EXPIRED link sends the seller, to ask you for a fresh one. */
  refresh_url: string;
  /** Where the seller lands when onboarding is done. Proves nothing — read the account. */
  return_url: string;
  /**
   * Which half to onboard. `card` (the default) is the provider's hosted KYC;
   * `faircoin` is Peable's page in the wallet, where the seller — signed in
   * with Oxy as the account's `oxy_user_id` — registers their watch-only key
   * (ADR 0012 D3). The FairCoin link works for an hour and only for that user.
   */
  rail?: 'card' | 'faircoin';
}

export type { AccountLink };

export class ConnectedAccountsResource {
  constructor(private readonly client: RestClient) {}

  /**
   * Open the account for a seller, or return the one they already have.
   *
   * Converges rather than erroring, because the underlying object CANNOT BE
   * DELETED: opening two for one seller leaves them with two forever, one of
   * which nobody uses and which keeps generating requirement emails.
   */
  create(params: CreateConnectedAccountParams): Promise<ConnectedAccount> {
    return this.client.request<ConnectedAccount>('POST', '/v1/connected_accounts', {
      body: params,
    });
  }

  /** Your sellers, newest first; await one page or iterate them all. */
  list(params: ConnectedAccountListParams = {}): ApiListPromise<ConnectedAccount> {
    return listPromise(
      (page: ConnectedAccountListParams) =>
        this.client.request<ConnectedAccountList>('GET', '/v1/connected_accounts', {
          query: listQuery(page),
        }),
      params,
    );
  }

  retrieve(accountId: string): Promise<ConnectedAccount> {
    return this.client.request<ConnectedAccount>(
      'GET',
      `/v1/connected_accounts/${encodeURIComponent(accountId)}`,
    );
  }

  /**
   * By the merchant's OWN reference.
   *
   * The recovery read: a merchant who lost the `ca_…` — a create whose response
   * never arrived — still has the reference they chose, and this is what makes
   * finding the account possible without a list scan.
   */
  retrieveByRef(externalRef: string): Promise<ConnectedAccount> {
    return this.client.request<ConnectedAccount>(
      'GET',
      `/v1/connected_accounts/by_ref/${encodeURIComponent(externalRef)}`,
    );
  }

  /**
   * Re-read this account from the provider now.
   *
   * Rarely needed: readiness arrives on its own through the gateway's event
   * drain and a backstop sweep. This is for a seller staring at a dashboard who
   * has just finished onboarding.
   */
  refresh(accountId: string): Promise<ConnectedAccount> {
    return this.client.request<ConnectedAccount>(
      'POST',
      `/v1/connected_accounts/${encodeURIComponent(accountId)}/refresh`,
    );
  }

  /**
   * A hosted onboarding link.
   *
   * SINGLE-USE and short-lived at the provider, so it is minted on demand and
   * must never be stored, emailed or put in a chat message — a stored link is
   * one that has already expired by the time anyone follows it, and the failure
   * looks like the seller's fault.
   *
   * A visit to `return_url` proves NOTHING about verification. Read the account
   * back, or wait for the readiness event.
   */
  createAccountLink(accountId: string, params: AccountLinkParams): Promise<AccountLink> {
    return this.client.request<AccountLink>(
      'POST',
      `/v1/connected_accounts/${encodeURIComponent(accountId)}/account_links`,
      { body: params },
    );
  }
}

/** `accountLinks.create` for a SELLER — Stripe's `AccountLink.create`, naming the account in the body. */
export interface CreateAccountLinkParams extends AccountLinkParams {
  /** The seller's `ca_…`. */
  account: string;
}

/**
 * `peable.accountLinks` — onboarding links, Stripe-named.
 *
 * With `account` it is `connectedAccounts.createAccountLink` for that seller
 * (and takes `rail`). Without one it onboards the MERCHANT's own fiat account
 * (`POST /v1/account_links`, ADR 0015 §1) — or, with `{ peableAccount }`, one
 * of a platform's sellers through that same route.
 */
export class AccountLinksResource {
  constructor(
    private readonly accounts: ConnectedAccountsResource,
    private readonly account?: AccountResource,
  ) {}

  create(
    params: CreateAccountLinkParams | (CreateMerchantAccountLinkParams & { account?: undefined }),
    options: PeableRequestOptions = {},
  ): Promise<AccountLink> {
    if (params.account !== undefined) {
      const { account, ...link } = params;
      return this.accounts.createAccountLink(account, link);
    }
    if (!this.account) {
      return Promise.reject(
        new TypeError(
          'accountLinks.create without `account` needs an AccountResource; use peable.accountLinks',
        ),
      );
    }
    const { account: _none, ...link } = params;
    return this.account.createLink(link, options);
  }
}
