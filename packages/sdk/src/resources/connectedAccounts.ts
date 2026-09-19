import type { ConnectedAccount } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';

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

export interface CreateConnectedAccountParams {
  /** The merchant's own id for this seller. The idempotency, and durable. */
  externalRef: string;
  /** ISO 3166-1 alpha-2. Case-insensitive; the gateway upper-cases it. */
  country: string;
  businessType: 'individual' | 'company';
}

export interface ConnectedAccountListParams {
  limit?: number;
  /** A `ca_…` from a previous page — the gateway resolves it, scoped to you. */
  starting_after?: string;
}

export interface ConnectedAccountList {
  object: 'list';
  data: ConnectedAccount[];
  has_more: boolean;
}

export interface AccountLinkParams {
  /** Where the provider sends a seller whose link expired mid-flow. */
  refreshUrl: string;
  returnUrl: string;
}

export interface AccountLink {
  object: 'account_link';
  url: string;
  expiresAt: string;
}

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

  list(params: ConnectedAccountListParams = {}): Promise<ConnectedAccountList> {
    return this.client.request<ConnectedAccountList>('GET', '/v1/connected_accounts', {
      query: { limit: params.limit, starting_after: params.starting_after },
    });
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
   * A visit to `returnUrl` proves NOTHING about verification. Read the account
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
