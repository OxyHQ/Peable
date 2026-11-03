import type { Charge, ExpandParams, List, ListParams, SearchParams } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { searchResource } from '../core/search';
import { type ApiListPromise, type ApiSearchPromise, listPromise, listQuery } from '../core/list';

/**
 * Charges (ADR 0019) — read-only. A `ch_…` is the authorization a CARD payment
 * obtained: what was captured, what came back (`amount_refunded`), the outcome
 * and the card. It is written by the payment's own lifecycle, never through
 * this API, and a FairCoin payment has none (its chain side is
 * `PaymentIntent.faircoin`).
 */
export interface ChargeListParams extends ListParams {
  /** Only the charge of this payment (`pi_…`). */
  payment_intent?: string;
}

export type ChargeList = List<Charge>;

export class ChargesResource {
  constructor(private readonly client: RestClient) {}

  /** `expand: ['payment_intent']` returns the payment instead of its `pi_…`. */
  retrieve(id: string, params: ExpandParams = {}): Promise<Charge> {
    return this.client.request<Charge>('GET', `/v1/charges/${encodeURIComponent(id)}`, {
      query: { expand: params.expand },
    });
  }

  /** Your charges, newest first; a page promise and an async iterable. */
  list(params: ChargeListParams = {}): ApiListPromise<Charge> {
    return listPromise(
      (page: ChargeListParams) =>
        this.client.request<ChargeList>('GET', '/v1/charges', {
          query: listQuery(page, { payment_intent: page.payment_intent }),
        }),
      params,
    );
  }

  /**
   * Search in Stripe's query language — `amount`, `currency`, `customer`, `payment_intent`, `status`, `captured`, `refunded`, `disputed`, `billing_details.email|name|address.postal_code`, `payment_method_details.card.last4|brand`, `created`, `metadata['key']`. Clauses join
   * with spaces / `AND` or with `OR`, never both. A page promise and an async
   * iterable that follows `next_page`; `expand: ['total_count']` counts every
   * match.
   */
  search(params: SearchParams): ApiSearchPromise<Charge> {
    return searchResource<Charge>(this.client, 'charges', params);
  }
}
