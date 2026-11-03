import type {
  Account,
  AccountLink,
  CreateAccountLinkParams as CreateMerchantAccountLinkParams,
  UpdateAccountParams,
} from '@peable.to/shared-types';
import { type PeableRequestOptions, type RestClient, requestOptionsOf } from '../core/client';

/**
 * The merchant's own fiat account (ADR 0015 §1) — `peable.account`.
 *
 * Orbit's fiat funds never reach a Peable bank account: a merchant that takes
 * cards has its OWN provider account, opened and onboarded through Peable, and
 * this object mirrors it. Readiness (`charges_enabled`, `payouts_enabled`,
 * `requirements`) is what the provider last reported; Orbit never decides it.
 *
 * A marketplace platform reads or updates one of its sellers' accounts in the
 * same shape by passing `{ peableAccount: 'ca_…' }`.
 */
export class AccountResource {
  constructor(private readonly client: RestClient) {}

  /**
   * The account, as last read from the provider.
   *
   * A merchant with no fiat account is a 404 with `code: 'account_missing'` —
   * never an empty account, and never a zero balance.
   */
  retrieve(options: PeableRequestOptions = {}): Promise<Account> {
    return this.client.request<Account>('GET', '/v1/account', requestOptionsOf(options));
  }

  /**
   * Write settings to the provider and read the account back.
   *
   * The FIRST call opens the account and needs `country` and `business_type`
   * (the gateway answers 201); afterwards `country` is refused, because a
   * provider account's country cannot change. The payout schedule lives under
   * `settings.payouts.schedule` — `interval: 'manual'` means only
   * `payouts.create` pays the balance out.
   */
  update(params: UpdateAccountParams, options: PeableRequestOptions = {}): Promise<Account> {
    return this.client.request<Account>('POST', '/v1/account', {
      body: params,
      ...requestOptionsOf(options),
    });
  }

  /**
   * A hosted onboarding link for this account (`POST /v1/account_links`).
   * `peable.accountLinks.create` without an `account` is this call.
   *
   * Single-use and short-lived: mint it when the merchant clicks, never store
   * it. A visit to `return_url` proves nothing — read the account back.
   */
  createLink(
    params: CreateMerchantAccountLinkParams,
    options: PeableRequestOptions = {},
  ): Promise<AccountLink> {
    return this.client.request<AccountLink>('POST', '/v1/account_links', {
      body: params,
      ...requestOptionsOf(options),
    });
  }
}

export type { CreateMerchantAccountLinkParams };
