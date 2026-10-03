import type { CheckoutSession, CreateCheckoutSessionParams } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';

export interface CreateCheckoutSessionOptions {
  /**
   * Sent as `Idempotency-Key`. A create that timed out does not tell the caller
   * whether the session exists; retrying with the SAME key returns the session
   * that create made (HTTP 200) instead of minting a second one and a second
   * payment intent, and the same key with different parameters is refused with
   * a 409 (`PeableInvalidRequestError`). Use one stable key per order, not one
   * per attempt.
   *
   * Optional, because the gateway has never required it on this route — but an
   * integration without it can create two live checkouts for one order.
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

  retrieve(id: string): Promise<CheckoutSession> {
    return this.client.request<CheckoutSession>(
      'GET',
      `/v1/checkout_sessions/${encodeURIComponent(id)}`,
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
