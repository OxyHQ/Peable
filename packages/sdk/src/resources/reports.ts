import type {
  BalanceTransaction,
  ListParams,
  PayoutReconciliationReport,
} from '@peable.to/shared-types';
import { type PeableRequestOptions, type RestClient, requestOptionsOf } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

export interface PayoutReconciliationParams extends ListParams {
  /** The payout (`po_…`) to reconcile. */
  payout: string;
}

/** Reports over the ledger (ADR 0015 §4). */
export class ReportsResource {
  constructor(private readonly client: RestClient) {}

  /**
   * The balance transactions one payout paid out, with their totals.
   *
   * A page of `BalanceTransaction`s with the report beside the envelope;
   * iterate it for every transaction. `summary` already covers ALL of them,
   * not just this page. `status: 'pending'` means the set is not final — the
   * payout is not `paid` yet, and the totals may still grow.
   */
  payoutReconciliation(
    params: PayoutReconciliationParams,
    options: PeableRequestOptions = {},
  ): ApiListPromise<BalanceTransaction, PayoutReconciliationReport> {
    return listPromise(
      (page: PayoutReconciliationParams) =>
        this.client.request<PayoutReconciliationReport>(
          'GET',
          '/v1/reports/payout_reconciliation',
          { query: listQuery(page, { payout: page.payout }), ...requestOptionsOf(options) },
        ),
      params,
    );
  }
}
