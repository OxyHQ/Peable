import type { ApplicationFee, FeeRefund, List, ListParams } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * Orbit's fee on a payment (`fee_…`, ADR 0015 §3), taken by the provider from
 * the merchant's account when the charge succeeded. Read-only: a fee is created
 * from the provider's own record, and refunded through `refunds.create({
 * refund_application_fee: true })`.
 */

export interface ApplicationFeeListParams extends ListParams {
  /** Only the fee taken on this payment (`pi_…`). */
  payment_intent?: string;
  /** Only the fee taken on this charge (`ch_…`). */
  charge?: string;
}

export type ApplicationFeeList = List<ApplicationFee>;

export type FeeRefundList = List<FeeRefund>;

function path(id: string): string {
  return `/v1/application_fees/${encodeURIComponent(id)}`;
}

export class ApplicationFeesResource {
  constructor(private readonly client: RestClient) {}

  retrieve(id: string): Promise<ApplicationFee> {
    return this.client.request<ApplicationFee>('GET', path(id));
  }

  list(params: ApplicationFeeListParams = {}): ApiListPromise<ApplicationFee> {
    return listPromise(
      (page: ApplicationFeeListParams) =>
        this.client.request<ApplicationFeeList>('GET', '/v1/application_fees', {
          query: listQuery(page, { payment_intent: page.payment_intent, charge: page.charge }),
        }),
      params,
    );
  }

  /** What of one fee went back (`fr_…`), newest first. */
  listRefunds(id: string, params: ListParams = {}): ApiListPromise<FeeRefund> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<FeeRefundList>('GET', `${path(id)}/refunds`, {
          query: listQuery(page),
        }),
      params,
    );
  }
}
