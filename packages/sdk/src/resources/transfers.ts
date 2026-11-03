import type {
  ExpandParams,
  List,
  ListParams,
  Transfer,
  TransferWithReversal,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * Settling a seller out of a funded payment, and taking it back.
 *
 * Two rules govern this whole surface and neither is negotiable:
 *
 * 1. **The amount comes from you.** Peable does not compute a marketplace's
 *    split and must never learn its fee schedule; it records that a stated
 *    amount was moved. A gateway that computed the split would be a second
 *    definition of it.
 * 2. **Your own id is the idempotency.** `external_ref` is your order id, and
 *    unlike a header key you cannot lose it — a retried settlement converges on
 *    it rather than paying a seller twice.
 */

export interface CreateTransferParams {
  /** The `pi_…` this settles out of. Must be a SETTLED payment. */
  payment_intent: string;
  /** Name the seller by exactly one of these: the `ca_…`, or your own reference. */
  connected_account?: string;
  connected_account_ref?: string;
  /** YOUR id for what this settles. The idempotency, and it is durable. */
  external_ref: string;
  /** Minor units, as a canonical integer string. In the payment's currency. */
  amount: string;
}

export interface ReverseTransferParams {
  amount: string;
  /**
   * YOUR id for THIS reversal — required, and durable.
   *
   * An AMOUNT IS NOT AN IDENTITY: two reversals of one settlement for the same
   * amount are two distinct operations, and a gateway that keyed them by
   * amount would answer the first one to the second request — leaving a
   * seller holding money that had been taken back, with nothing recording that
   * it was asked for. The `Idempotency-Key` is not this identity: it is the
   * 24-hour request-retry layer, and this client mints a fresh one per call.
   */
  external_ref: string;
}

export type TransferList = List<Transfer>;

export interface TransferListParams extends ListParams {
  /** Only what this payment (`pi_…`) settled. */
  payment_intent?: string;
  /** Only what this seller (`ca_…`) was paid. */
  connected_account?: string;
}

export class TransfersResource {
  constructor(private readonly client: RestClient) {}

  /**
   * Settle one seller.
   *
   * Answers 201 for a new settlement and 200 for an order already settled,
   * which is the distinction to act on after a timeout: "did I just pay this
   * seller a second time" is a question with a real answer.
   *
   * Refused when the payment cannot fund it — the total settled out of one
   * payment may not exceed what that payment brought in, because the overflow
   * would come from the platform's general balance, which is other merchants'
   * money in flight.
   */
  create(
    params: CreateTransferParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<Transfer> {
    return this.client.request<Transfer>('POST', '/v1/transfers', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * Take some or all of a settlement back.
   *
   * The response carries the transfer AND the reversal leg, so a caller can
   * tell which operation it is reading: `amount_reversed` on the transfer is the
   * provider's CUMULATIVE figure, while `reversal` is this one.
   */
  reverse(
    transferId: string,
    params: ReverseTransferParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<TransferWithReversal> {
    return this.client.request<TransferWithReversal>(
      'POST',
      `/v1/transfers/${encodeURIComponent(transferId)}/reversals`,
      {
        body: params,
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      },
    );
  }

  /** One settlement, by `tr_…`. Expand `payment_intent` and/or `connected_account`. */
  retrieve(id: string, params: ExpandParams = {}): Promise<Transfer> {
    return this.client.request<Transfer>('GET', `/v1/transfers/${encodeURIComponent(id)}`, {
      query: { expand: params.expand },
    });
  }

  /** Every settlement, newest first — narrowed by payment and/or seller. */
  list(params: TransferListParams = {}): ApiListPromise<Transfer> {
    return listPromise(
      (page: TransferListParams) =>
        this.client.request<TransferList>('GET', '/v1/transfers', {
          query: listQuery(page, {
            payment_intent: page.payment_intent,
            connected_account: page.connected_account,
          }),
        }),
      params,
    );
  }

  /** What one payment settled — the reconciliation read. */
  listForPaymentIntent(paymentIntentId: string, params: ListParams = {}): ApiListPromise<Transfer> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<TransferList>(
          'GET',
          `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/transfers`,
          { query: listQuery(page) },
        ),
      params,
    );
  }
}
