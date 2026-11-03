import type {
  Balance,
  BalanceTransaction,
  List,
  ListBalanceTransactionsParams,
  ListParams,
} from '@peable.to/shared-types';
import { type PeableRequestOptions, type RestClient, requestOptionsOf } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * The balance and the ledger behind it (ADR 0015 §4) — MIRRORS of the
 * merchant's own provider account. The money is never in a Peable account;
 * Orbit records what the provider reports and reconciles against it daily.
 *
 * Every amount is a canonical integer string in the currency's smallest unit,
 * and it MAY be negative (`"-1500"`): a refund or a payout takes money out.
 */
export class BalanceResource {
  constructor(private readonly client: RestClient) {}

  /**
   * Available, pending and informational funds, per currency.
   *
   * `informational` is FairCoin received straight into the merchant's own
   * wallet: recorded for the books, never payable, never drawn on by a payout.
   * A merchant without a fiat account is a 404 `account_missing`, not zeros.
   */
  retrieve(options: PeableRequestOptions = {}): Promise<Balance> {
    return this.client.request<Balance>('GET', '/v1/balance', requestOptionsOf(options));
  }
}

export type BalanceTransactionListParams = ListParams & ListBalanceTransactionsParams;

export type BalanceTransactionList = List<BalanceTransaction>;

/** Every movement of the balance (`txn_…`), newest first. */
export class BalanceTransactionsResource {
  constructor(private readonly client: RestClient) {}

  retrieve(id: string, options: PeableRequestOptions = {}): Promise<BalanceTransaction> {
    return this.client.request<BalanceTransaction>(
      'GET',
      `/v1/balance_transactions/${encodeURIComponent(id)}`,
      requestOptionsOf(options),
    );
  }

  /**
   * Narrowed by `type`, `payout` (what one payout paid out), `source` (the
   * object that caused it) and `currency`. `fee` and `net` are `null` when the
   * provider gave no figure — never `0`.
   */
  list(
    params: BalanceTransactionListParams = {},
    options: PeableRequestOptions = {},
  ): ApiListPromise<BalanceTransaction> {
    return listPromise(
      (page: BalanceTransactionListParams) =>
        this.client.request<BalanceTransactionList>('GET', '/v1/balance_transactions', {
          query: listQuery(page, {
            type: page.type,
            payout: page.payout,
            source: page.source,
            currency: page.currency,
          }),
          ...requestOptionsOf(options),
        }),
      params,
    );
  }
}
