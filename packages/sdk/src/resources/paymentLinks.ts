import type { CreatePaymentLinkParams, PaymentLink } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';

export interface PaymentLinkListParams {
  limit?: number;
  starting_after?: string;
}

export interface PaymentLinkList {
  object: 'list';
  data: PaymentLink[];
  has_more: boolean;
}

/**
 * Fields mutable after a link is created. `amount`/`network` are
 * deliberately absent — a link's price is immutable once shared (the
 * Gateway's `PATCH /v1/payment_links/:id` whitelist enforces the same).
 */
export interface UpdatePaymentLinkParams {
  active?: boolean;
  metadata?: Record<string, string>;
  successUrl?: string;
}

export class PaymentLinksResource {
  constructor(private readonly client: RestClient) {}

  create(params: CreatePaymentLinkParams): Promise<PaymentLink> {
    return this.client.request<PaymentLink>('POST', '/v1/payment_links', { body: params });
  }

  retrieve(id: string): Promise<PaymentLink> {
    return this.client.request<PaymentLink>('GET', `/v1/payment_links/${encodeURIComponent(id)}`);
  }

  list(params: PaymentLinkListParams = {}): Promise<PaymentLinkList> {
    return this.client.request<PaymentLinkList>('GET', '/v1/payment_links', {
      query: { limit: params.limit, starting_after: params.starting_after },
    });
  }

  update(id: string, params: UpdatePaymentLinkParams): Promise<PaymentLink> {
    return this.client.request<PaymentLink>(
      'PATCH',
      `/v1/payment_links/${encodeURIComponent(id)}`,
      { body: params },
    );
  }
}
