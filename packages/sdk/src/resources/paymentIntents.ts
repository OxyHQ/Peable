import type {
  CreatePaymentIntentParams,
  PaymentIntent,
  PaymentIntentStatus,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';

export interface PaymentIntentListParams {
  status?: PaymentIntentStatus;
  limit?: number;
  starting_after?: string;
}

export interface PaymentIntentList {
  object: 'list';
  data: PaymentIntent[];
  has_more: boolean;
}

/**
 * The payer's next step, as the gateway reports it.
 *
 * `value` is opaque and provider-specific — a confirmation credential or a
 * redirect target. Do not store it, do not log it, and do not put it in a URL:
 * it is a capability over the payment at the acquirer, and it is read live from
 * the provider precisely so nothing here has to keep one.
 *
 * `publishableKey` is the provider's PUBLIC key, served here rather than
 * configured in the client, so a page that talks to more than one deployment
 * cannot mount a live card form over a test payment.
 */
export interface PaymentIntentClientAction {
  object: 'client_action';
  kind: 'client_secret' | 'redirect';
  value: string;
  publishableKey?: string;
}

export interface CreatePaymentIntentOptions {
  /**
   * Required — the Gateway mandates the `Idempotency-Key` header on
   * `POST /v1/payment_intents` (`paymentIntents.ts`'s `idempotencyKey`
   * check). Making this a required option (not optional) means a caller
   * cannot forget it.
   */
  idempotencyKey: string;
}

export class PaymentIntentsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreatePaymentIntentParams,
    options: CreatePaymentIntentOptions,
  ): Promise<PaymentIntent> {
    return this.client.request<PaymentIntent>('POST', '/v1/payment_intents', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string): Promise<PaymentIntent> {
    return this.client.request<PaymentIntent>(
      'GET',
      `/v1/payment_intents/${encodeURIComponent(id)}`,
    );
  }

  list(params: PaymentIntentListParams = {}): Promise<PaymentIntentList> {
    return this.client.request<PaymentIntentList>('GET', '/v1/payment_intents', {
      query: {
        status: params.status,
        limit: params.limit,
        starting_after: params.starting_after,
      },
    });
  }

  /**
   * Reject a payment the payer has not completed.
   *
   * The gateway CANCELS it at the provider before it announces anything, so
   * this can lose a race and say so: a 409 means the payer confirmed first and
   * the payment is settled, and a 502 means the provider could not be reached
   * and nothing was decided. Neither is a failure of the request — both are
   * facts about a payment that is still live.
   */
  reject(id: string): Promise<PaymentIntent> {
    return this.client.request<PaymentIntent>(
      'POST',
      `/v1/payment_intents/${encodeURIComponent(id)}/reject`,
    );
  }

  /**
   * What the PAYER's client has to do next — the resume operation.
   *
   * The payment-intent shape carries no confirmation credential, because a
   * credential on that shape would be handed out by every list and every
   * re-read. This is the bounded way to get one: a single payment, named
   * explicitly, for a caller who has proven they may pay it.
   *
   * Call it to resume an unpaid checkout rather than creating a second payment
   * — which is what a buyer returning the next day would otherwise produce, and
   * an idempotency key that has aged out at the provider will not prevent.
   *
   * @throws {PeableInvalidRequestError} (409) when the payment can no longer be
   *   paid, so a surface handed this can never render a card form over a
   *   settled payment.
   */
  clientAction(id: string): Promise<PaymentIntentClientAction> {
    return this.client.request<PaymentIntentClientAction>(
      'POST',
      `/v1/payment_intents/${encodeURIComponent(id)}/client_action`,
    );
  }
}
