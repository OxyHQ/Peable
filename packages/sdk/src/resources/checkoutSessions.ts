import type {
  CheckoutSession,
  CreateCheckoutSessionParams,
  ExpandParams,
  List,
  ListParams,
  UpdateCheckoutSessionParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

export interface CheckoutSessionListParams extends ListParams {
  /** Only the session wrapping this payment (`pi_…`). */
  payment_intent?: string;
}

export type CheckoutSessionList = List<CheckoutSession>;

export interface CreateCheckoutSessionOptions {
  /**
   * Sent as `Idempotency-Key`. A create that timed out does not tell the caller
   * whether the session exists; retrying with the SAME key returns the session
   * that create made instead of minting a second one and a second payment
   * intent — within 24 hours as the stored response (`Idempotent-Replayed:
   * true`), after that through the key the session's payment carries. The same
   * key with different parameters is refused (`PeableInvalidRequestError`,
   * code `idempotency_error`).
   *
   * Optional: without it the client mints one per call, which covers a retry
   * of that call only. Use one stable key per order to cover a retry from
   * another call.
   */
  idempotencyKey?: string;
}

export class CheckoutSessionsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateCheckoutSessionParams,
    options: CreateCheckoutSessionOptions = {},
  ): Promise<CheckoutSession> {
    return this.client.request<CheckoutSession>('POST', '/v1/checkout_sessions', {
      body: params,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
  }

  /** `expand: ['payment_intent']` returns the wrapped payment instead of its `pi_…`. */
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
          query: listQuery(page, { payment_intent: page.payment_intent }),
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
}

/** `peable.checkout.sessions.*` — a thin namespace wrapper so the public API
 * reads `peable.checkout.sessions.create(...)` (Stripe Checkout Session
 * parity), leaving room for future `peable.checkout.*` resources. */
export class CheckoutResource {
  readonly sessions: CheckoutSessionsResource;

  constructor(client: RestClient) {
    this.sessions = new CheckoutSessionsResource(client);
  }
}
