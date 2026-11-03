import type {
  CreatePaymentIntentParams,
  ExpandParams,
  List,
  ListParams,
  PaymentIntent,
  PaymentIntentStatus,
  UpdatePaymentIntentParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

export interface PaymentIntentListParams extends ListParams {
  status?: PaymentIntentStatus;
  /** Only the payments made on behalf of this seller (`ca_…`, ADR 0012). */
  connected_account?: string;
}

export type PaymentIntentList = List<PaymentIntent>;

/**
 * The payer's next step, as the gateway reports it.
 *
 * `value` is opaque and provider-specific — a confirmation credential or a
 * redirect target. Do not store it, do not log it, and do not put it in a URL:
 * it is a capability over the payment at the acquirer, and it is read live from
 * the provider precisely so nothing here has to keep one.
 *
 * `publishable_key` is the provider's PUBLIC key, served here rather than
 * configured in the client, so a page that talks to more than one deployment
 * cannot mount a live card form over a test payment.
 */
export interface PaymentIntentClientAction {
  object: 'client_action';
  kind: 'client_secret' | 'redirect';
  value: string;
  publishable_key?: string;
}

export interface CreatePaymentIntentOptions {
  /**
   * Sent as `Idempotency-Key`. Optional: without it the client mints one per
   * call, so a retry of that call is answered with the first result. Pass one
   * stable key per order to make a retry from ANOTHER call — after a crash,
   * from a job queue — return the same payment: within 24 hours the gateway
   * replays the stored response (`Idempotent-Replayed: true`), and after that
   * the key still names the one payment it created. The same key with
   * different parameters is refused (`PeableInvalidRequestError`, code
   * `idempotency_error`).
   */
  idempotencyKey?: string;
}

export class PaymentIntentsResource {
  constructor(private readonly client: RestClient) {}

  /**
   * Create a payment. With `connected_account: 'ca_…'` it is made ON BEHALF OF
   * that seller (ADR 0012): FairCoin only, the address derives from the
   * seller's own key so the coins go straight to their wallet, and you still
   * own the payment and receive its webhooks (each tagged `event.account`).
   * A seller who has not registered their key yet is a 409 with
   * `code: 'account_not_ready'`.
   */
  create(
    params: CreatePaymentIntentParams,
    options: CreatePaymentIntentOptions = {},
  ): Promise<PaymentIntent> {
    return this.client.request<PaymentIntent>('POST', '/v1/payment_intents', {
      body: params,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
  }

  /** `expand: ['connected_account']` returns the seller instead of its `ca_…`. */
  retrieve(id: string, params: ExpandParams = {}): Promise<PaymentIntent> {
    return this.client.request<PaymentIntent>(
      'GET',
      `/v1/payment_intents/${encodeURIComponent(id)}`,
      { query: { expand: params.expand } },
    );
  }

  /**
   * Your payments, newest first. Await it for one page, or iterate it —
   * `for await (const intent of peable.paymentIntents.list())` — to walk every
   * page.
   */
  list(params: PaymentIntentListParams = {}): ApiListPromise<PaymentIntent> {
    return listPromise(
      (page: PaymentIntentListParams) =>
        this.client.request<PaymentIntentList>('GET', '/v1/payment_intents', {
          query: listQuery(page, {
            status: page.status,
            connected_account: page.connected_account,
          }),
        }),
      params,
    );
  }

  /**
   * Update a payment's `metadata` — the only mutable field. A patch: named
   * keys are set, a key sent as `''` is removed, others are kept. At most 50
   * keys, 40-character keys and 500-character values.
   */
  update(
    id: string,
    params: UpdatePaymentIntentParams & ExpandParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<PaymentIntent> {
    return this.client.request<PaymentIntent>(
      'POST',
      `/v1/payment_intents/${encodeURIComponent(id)}`,
      { body: params, idempotencyKey: options.idempotencyKey },
    );
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
  reject(id: string, options: { idempotencyKey?: string } = {}): Promise<PaymentIntent> {
    return this.client.request<PaymentIntent>(
      'POST',
      `/v1/payment_intents/${encodeURIComponent(id)}/reject`,
      options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey },
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
