import type {
  CreatePaymentLinkParams,
  List,
  ListParams,
  PaymentLink,
  UpdatePaymentLinkParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

export interface PaymentLinkListParams extends ListParams {
  /** Only active (or only inactive) links. */
  active?: boolean;
}

export type PaymentLinkList = List<PaymentLink>;

export type { UpdatePaymentLinkParams };

export class PaymentLinksResource {
  constructor(private readonly client: RestClient) {}

  create(params: CreatePaymentLinkParams): Promise<PaymentLink> {
    return this.client.request<PaymentLink>('POST', '/v1/payment_links', { body: params });
  }

  retrieve(id: string): Promise<PaymentLink> {
    return this.client.request<PaymentLink>('GET', `/v1/payment_links/${encodeURIComponent(id)}`);
  }

  /** Your links, newest first; await one page or iterate them all. */
  list(params: PaymentLinkListParams = {}): ApiListPromise<PaymentLink> {
    return listPromise(
      (page: PaymentLinkListParams) =>
        this.client.request<PaymentLinkList>('GET', '/v1/payment_links', {
          query: listQuery(page, { active: page.active }),
        }),
      params,
    );
  }

  /**
   * Update the mutable fields — `POST`, as every update on this API is.
   * `amount`/`network` are absent: a link's price is immutable once shared.
   * `metadata` is a patch (`''` removes a key).
   */
  update(id: string, params: UpdatePaymentLinkParams): Promise<PaymentLink> {
    return this.client.request<PaymentLink>('POST', `/v1/payment_links/${encodeURIComponent(id)}`, {
      body: params,
    });
  }
}
