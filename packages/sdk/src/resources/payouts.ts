import type {
  CreatePayoutParams,
  List,
  ListParams,
  ListPayoutsParams,
  Payout,
} from '@peable.to/shared-types';
import { type PeableRequestOptions, type RestClient, requestOptionsOf } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * Payouts (`po_…`, ADR 0015 §5): the provider moving the merchant's balance to
 * the merchant's bank. The provider executes every one of them; Orbit
 * instructs a manual payout and mirrors a scheduled one. The bank account
 * itself stays at the provider and is never on a payout.
 */

export type PayoutListParams = ListParams & ListPayoutsParams;

export type PayoutList = List<Payout>;

function path(id: string): string {
  return `/v1/payouts/${encodeURIComponent(id)}`;
}

export class PayoutsResource {
  constructor(private readonly client: RestClient) {}

  /**
   * Pay part of the AVAILABLE balance out — for an account whose schedule is
   * `manual`. The answer is the instruction, usually `pending`; `payout.paid`
   * or `payout.failed` says what the bank did.
   */
  create(params: CreatePayoutParams, options: PeableRequestOptions = {}): Promise<Payout> {
    return this.client.request<Payout>('POST', '/v1/payouts', {
      body: params,
      ...requestOptionsOf(options),
    });
  }

  retrieve(id: string, options: PeableRequestOptions = {}): Promise<Payout> {
    return this.client.request<Payout>('GET', path(id), requestOptionsOf(options));
  }

  /** Every payout, newest first — or only those in one `status`. */
  list(params: PayoutListParams = {}, options: PeableRequestOptions = {}): ApiListPromise<Payout> {
    return listPromise(
      (page: PayoutListParams) =>
        this.client.request<PayoutList>('GET', '/v1/payouts', {
          query: listQuery(page, { status: page.status }),
          ...requestOptionsOf(options),
        }),
      params,
    );
  }

  /** Cancel a `pending` payout, where the provider still allows it. */
  cancel(id: string, options: PeableRequestOptions = {}): Promise<Payout> {
    return this.client.request<Payout>('POST', `${path(id)}/cancel`, requestOptionsOf(options));
  }
}
