import type {
  ExpandParams,
  List,
  ListParams,
  PaymentMethod,
  UpdatePaymentMethodParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * Saved payment methods (`pm_…`, ADR 0016). A `pm_…` is born attached to a
 * customer when a SetupIntent — or a payment with `setup_future_usage` —
 * succeeds; the card number never reaches Peable. There is no create or attach,
 * and a detached method is permanently unusable.
 */
export interface PaymentMethodListParams extends ListParams {
  /** Required: the `cus_…` whose attached methods to list. */
  customer: string;
  type?: 'card';
}

export type PaymentMethodList = List<PaymentMethod>;

export class PaymentMethodsResource {
  constructor(private readonly client: RestClient) {}

  retrieve(id: string, params: ExpandParams = {}): Promise<PaymentMethod> {
    return this.client.request<PaymentMethod>(
      'GET',
      `/v1/payment_methods/${encodeURIComponent(id)}`,
      { query: { expand: params.expand } },
    );
  }

  /** Billing details and metadata (a patch). */
  update(
    id: string,
    params: UpdatePaymentMethodParams & ExpandParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<PaymentMethod> {
    return this.client.request<PaymentMethod>(
      'POST',
      `/v1/payment_methods/${encodeURIComponent(id)}`,
      { body: params, idempotencyKey: options.idempotencyKey },
    );
  }

  /** Detach — permanently, at the provider too. */
  detach(id: string, options: { idempotencyKey?: string } = {}): Promise<PaymentMethod> {
    return this.client.request<PaymentMethod>(
      'POST',
      `/v1/payment_methods/${encodeURIComponent(id)}/detach`,
      { body: {}, idempotencyKey: options.idempotencyKey },
    );
  }

  /** A customer's attached methods, newest first. */
  list(params: PaymentMethodListParams): ApiListPromise<PaymentMethod> {
    return listPromise(
      (page: PaymentMethodListParams) =>
        this.client.request<PaymentMethodList>('GET', '/v1/payment_methods', {
          query: listQuery(page, { customer: page.customer, type: page.type }),
        }),
      params,
    );
  }
}
