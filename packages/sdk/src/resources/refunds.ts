import type {
  CreateRefundParams,
  ExpandParams,
  List,
  ListParams,
  Refund,
  Settlement,
  UpdateRefundParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * Sending money back to a payer.
 *
 * The one operation on this API whose duplicate is unrecoverable: a payer sent
 * their money twice has no reason to report it, and nothing reverses the second
 * automatically. `external_ref` — your own refund id — is what every path here
 * converges on, and unlike a header key you cannot lose it.
 */

/**
 * `POST /v1/refunds` — the wire contract's own shape (`payment_intent`,
 * `external_ref`, `amount`, and optionally `reason`, `metadata`,
 * `refund_application_fee`, `reverse_transfer`).
 */
export type { CreateRefundParams, UpdateRefundParams };

export interface RefundListParams extends ListParams {
  /** Only the refunds of this payment (`pi_…`). */
  payment_intent?: string;
}

/** A payment's refunds, with what can still go back beside the envelope. */
export interface RefundList extends List<Refund> {
  /**
   * What can still go back, in minor units.
   *
   * Offered because otherwise every integrator computes it by summing the list
   * — and the ones who forget that a `pending` or `failed` refund moved no
   * money compute it wrong, in the direction that refuses a legitimate refund.
   * It reserves PENDING refunds, which is what stops two concurrent ones
   * between them exceeding the payment.
   */
  remaining_refundable: string;
}

export class RefundsResource {
  constructor(private readonly client: RestClient) {}

  /**
   * Refund part or all of a payment.
   *
   * **`status` is the refund's own lifecycle and it is not always
   * `succeeded`.** A provider can report a refund `pending` — and a bank can
   * reject one days later, which arrives as an event and moves the row to
   * `failed`. Treating the creation as completion is how a merchant's books
   * come to say money went back that is still with them.
   *
   * The PAYMENT does not change status with a refund (ADR 0019): it stays
   * `succeeded`, and its `amount_refunded` is the sum of succeeded refunds.
   */
  create(params: CreateRefundParams, options: { idempotencyKey?: string } = {}): Promise<Refund> {
    return this.client.request<Refund>('POST', '/v1/refunds', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * What this payment actually came to — gross, fee, net.
   *
   * On this resource because it is the same question you ask in the same
   * breath: how much of this money is really mine.
   *
   * **A missing figure is `null` with a `status`, never `0`.** `unknown` means
   * there is nothing to read — an uncaptured payment, a FairCoin one, a
   * provider that could not be reached — and treating it as zero is how a
   * reconciliation silently gains money that was never there.
   *
   * It reports what the provider took. It does NOT say which entity bears that
   * cost: a fee paid by the operator of a Peable deployment is not
   * automatically your expense, and that is a commercial question this API does
   * not answer.
   */
  settlement(paymentIntentId: string, params: ExpandParams = {}): Promise<Settlement> {
    return this.client.request<Settlement>(
      'GET',
      `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/settlement`,
      { query: { expand: params.expand } },
    );
  }

  /** One refund, by `re_…`. `expand: ['payment_intent']` returns the payment itself. */
  retrieve(id: string, params: ExpandParams = {}): Promise<Refund> {
    return this.client.request<Refund>('GET', `/v1/refunds/${encodeURIComponent(id)}`, {
      query: { expand: params.expand },
    });
  }

  /** Your own bookkeeping on a refund: `metadata` is a patch over what is stored. */
  update(id: string, params: UpdateRefundParams): Promise<Refund> {
    return this.client.request<Refund>('POST', `/v1/refunds/${encodeURIComponent(id)}`, {
      body: params,
    });
  }

  /**
   * Cancel a refund the provider has not executed yet. Read the answer's
   * `status`: only `canceled` means the money stays with you.
   */
  cancel(id: string): Promise<Refund> {
    return this.client.request<Refund>('POST', `/v1/refunds/${encodeURIComponent(id)}/cancel`);
  }

  /** Every refund, newest first — or one payment's, with `payment_intent`. */
  list(params: RefundListParams = {}): ApiListPromise<Refund> {
    return listPromise(
      (page: RefundListParams) =>
        this.client.request<List<Refund>>('GET', '/v1/refunds', {
          query: listQuery(page, { payment_intent: page.payment_intent }),
        }),
      params,
    );
  }

  /**
   * Every refund against one payment, including ones made OUTSIDE Peable.
   *
   * A refund issued from the acquirer's dashboard, or created by the network
   * resolving a dispute, is imported with `origin: 'provider'` and no
   * `external_ref` — the merchant did not make it and has no id for it.
   */
  listForPaymentIntent(
    paymentIntentId: string,
    params: ListParams = {},
  ): ApiListPromise<Refund, RefundList> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<RefundList>(
          'GET',
          `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/refunds`,
          { query: listQuery(page) },
        ),
      params,
    );
  }
}
