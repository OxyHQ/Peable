import type { Transfer, TransferWithReversal } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';

/**
 * Settling a seller out of a funded payment, and taking it back.
 *
 * Two rules govern this whole surface and neither is negotiable:
 *
 * 1. **The amount comes from you.** Peable does not compute a marketplace's
 *    split and must never learn its fee schedule; it records that a stated
 *    amount was moved. A gateway that computed the split would be a second
 *    definition of it.
 * 2. **Your own id is the idempotency.** `externalRef` is your order id, and
 *    unlike a header key you cannot lose it — a retried settlement converges on
 *    it rather than paying a seller twice.
 */

export interface CreateTransferParams {
  /** The `pi_…` this settles out of. Must be a SETTLED payment. */
  paymentIntentId: string;
  /** Name the seller by exactly one of these. */
  connectedAccountId?: string;
  connectedAccountRef?: string;
  /** YOUR id for what this settles. The idempotency, and it is durable. */
  externalRef: string;
  /** Minor units, as a canonical integer string. In the payment's currency. */
  amount: string;
}

export interface ReverseTransferParams {
  amount: string;
  /**
   * YOUR id for THIS reversal — required, one way or the other.
   *
   * Supply it here, or as `options.idempotencyKey`, which the gateway accepts
   * as the same identity. It cannot be omitted, and an AMOUNT IS NOT AN
   * IDENTITY: two reversals of one settlement for the same amount are two
   * distinct operations, and a gateway that keyed them by amount would answer
   * the first one to the second request — leaving a seller holding money that
   * had been taken back, with nothing recording that it was asked for.
   */
  externalRef?: string;
}

export interface TransferList {
  object: 'list';
  data: Transfer[];
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
  create(params: CreateTransferParams): Promise<Transfer> {
    return this.client.request<Transfer>('POST', '/v1/transfers', { body: params });
  }

  /**
   * Take some or all of a settlement back.
   *
   * The response carries the transfer AND the reversal leg, so a caller can
   * tell which operation it is reading: `amountReversed` on the transfer is the
   * provider's CUMULATIVE figure, while `reversal` is this one.
   */
  reverse(
    transferId: string,
    params: ReverseTransferParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<TransferWithReversal> {
    if (params.externalRef === undefined && options.idempotencyKey === undefined) {
      // Refused HERE rather than at the gateway, because the failure it
      // prevents is silent: without an identity a retry is a second reversal,
      // and a seller loses the amount twice with nothing saying so.
      throw new TypeError(
        'a reversal needs an identity: pass externalRef, or options.idempotencyKey',
      );
    }
    return this.client.request<TransferWithReversal>(
      'POST',
      `/v1/transfers/${encodeURIComponent(transferId)}/reversals`,
      {
        body: params,
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
      },
    );
  }

  /** What one payment settled — the reconciliation read. */
  listForPaymentIntent(paymentIntentId: string): Promise<TransferList> {
    return this.client.request<TransferList>(
      'GET',
      `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/transfers`,
    );
  }
}
