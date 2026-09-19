import type { Refund } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';

/**
 * Sending money back to a payer.
 *
 * The one operation on this API whose duplicate is unrecoverable: a payer sent
 * their money twice has no reason to report it, and nothing reverses the second
 * automatically. `externalRef` — your own refund id — is what every path here
 * converges on, and unlike a header key you cannot lose it.
 */

export interface CreateRefundParams {
  /** The `pi_…` being refunded. */
  paymentIntentId: string;
  /** YOUR id for this refund. The idempotency. */
  externalRef: string;
  /** Minor units, as a canonical integer string. Zero is refused. */
  amount: string;
}

export interface RefundList {
  object: 'list';
  data: Refund[];
  /**
   * What can still go back, in minor units.
   *
   * Offered because otherwise every integrator computes it by summing the list
   * — and the ones who forget that a `pending` or `failed` refund moved no
   * money compute it wrong, in the direction that refuses a legitimate refund.
   * It reserves PENDING refunds, which is what stops two concurrent ones
   * between them exceeding the payment.
   */
  remainingRefundable: string;
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
   * `paymentStatus` on the response is where the PAYMENT stands after it, so a
   * caller does not need a second read whose answer can move on before it
   * arrives.
   */
  create(params: CreateRefundParams): Promise<Refund> {
    return this.client.request<Refund>('POST', '/v1/refunds', { body: params });
  }

  /**
   * Every refund against one payment, including ones made OUTSIDE Peable.
   *
   * A refund issued from the acquirer's dashboard, or created by the network
   * resolving a dispute, is imported with `origin: 'provider'` and no
   * `externalRef` — the merchant did not make it and has no id for it.
   */
  listForPaymentIntent(paymentIntentId: string): Promise<RefundList> {
    return this.client.request<RefundList>(
      'GET',
      `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/refunds`,
    );
  }
}
