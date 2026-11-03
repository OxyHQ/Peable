import type {
  CheckoutLineItem,
  CheckoutSession,
  CheckoutSessionStatus,
  CreateCheckoutSessionParams,
  ExpandParams,
  List,
  ListParams,
  UpdateCheckoutSessionParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

export interface CheckoutSessionListParams extends ListParams {
  /** Only the session that created this payment (`pi_…`). */
  payment_intent?: string;
  /** Only the sessions started from this payment link (`link_…`). */
  payment_link?: string;
  /** Only this customer's sessions (`cus_…`). */
  customer?: string;
  status?: CheckoutSessionStatus;
}

export type CheckoutSessionList = List<CheckoutSession>;
export type CheckoutLineItemList = List<CheckoutLineItem>;

/** `expand: ['data.price']` / `['data.product']` return the catalog objects. */
export type CheckoutLineItemListParams = ListParams;

export interface CreateCheckoutSessionOptions {
  /**
   * Sent as `Idempotency-Key`. A create that timed out does not tell the caller
   * whether the session exists; retrying with the SAME key returns the session
   * that create made (`Idempotent-Replayed: true`, within 24 hours) instead of
   * a second one. The same key with different parameters is refused
   * (`PeableInvalidRequestError`, code `idempotency_error`).
   *
   * Optional: without it the client mints one per call, which covers a retry
   * of that call only. Use one stable key per order to cover a retry from
   * another call.
   */
  idempotencyKey?: string;
}

export class CheckoutSessionsResource {
  constructor(private readonly client: RestClient) {}

  /**
   * Create a session — an ORDER the payer completes on Peable's hosted
   * (`url`) or embedded (`client_secret`, `PeableCheckout.mountCheckout`)
   * checkout. No payment exists until the payer confirms; `payment_intent` is
   * `null` until then.
   */
  create(
    params: CreateCheckoutSessionParams,
    options: CreateCheckoutSessionOptions = {},
  ): Promise<CheckoutSession> {
    return this.client.request<CheckoutSession>('POST', '/v1/checkout_sessions', {
      body: params,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
  }

  /** `expand: ['payment_intent', 'customer', 'setup_intent']` return the objects. */
  retrieve(id: string, params: ExpandParams = {}): Promise<CheckoutSession> {
    return this.client.request<CheckoutSession>(
      'GET',
      `/v1/checkout_sessions/${encodeURIComponent(id)}`,
      { query: { expand: params.expand } },
    );
  }

  /** Your sessions, newest first; await one page or iterate them all. */
  list(params: CheckoutSessionListParams = {}): ApiListPromise<CheckoutSession> {
    return listPromise(
      (page: CheckoutSessionListParams) =>
        this.client.request<CheckoutSessionList>('GET', '/v1/checkout_sessions', {
          query: listQuery(page, {
            payment_intent: page.payment_intent,
            payment_link: page.payment_link,
            customer: page.customer,
            status: page.status,
          }),
        }),
      params,
    );
  }

  /** Update the session's `metadata` — a patch (`''` removes a key). */
  update(id: string, params: UpdateCheckoutSessionParams & ExpandParams): Promise<CheckoutSession> {
    return this.client.request<CheckoutSession>(
      'POST',
      `/v1/checkout_sessions/${encodeURIComponent(id)}`,
      { body: params },
    );
  }

  /**
   * Expire an `open` session now, so a payer can no longer complete it. Its
   * unpaid payment, if the payer had confirmed one, is cancelled. Refused
   * (400) for a session that is already `complete` or `expired`.
   */
  expire(id: string): Promise<CheckoutSession> {
    return this.client.request<CheckoutSession>(
      'POST',
      `/v1/checkout_sessions/${encodeURIComponent(id)}/expire`,
      { body: {} },
    );
  }

  /** The session's line items, in order; await one page or iterate them all. */
  listLineItems(
    id: string,
    params: CheckoutLineItemListParams = {},
  ): ApiListPromise<CheckoutLineItem> {
    return listPromise(
      (page: CheckoutLineItemListParams) =>
        this.client.request<CheckoutLineItemList>(
          'GET',
          `/v1/checkout_sessions/${encodeURIComponent(id)}/line_items`,
          { query: listQuery(page) },
        ),
      params,
    );
  }
}

/** `peable.checkout.sessions.*` — Stripe's `checkout.sessions` namespace. */
export class CheckoutResource {
  readonly sessions: CheckoutSessionsResource;

  constructor(client: RestClient) {
    this.sessions = new CheckoutSessionsResource(client);
  }
}
