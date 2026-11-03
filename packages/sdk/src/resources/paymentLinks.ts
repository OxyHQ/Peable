import type {
  CheckoutLineItem,
  CreatePaymentLinkParams,
  ExpandParams,
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
export type PaymentLinkLineItemList = List<CheckoutLineItem>;

export interface CreatePaymentLinkOptions {
  /** Sent as `Idempotency-Key`; minted per call when omitted. */
  idempotencyKey?: string;
}

export type { UpdatePaymentLinkParams };

/**
 * Payment links (v2): a shareable URL over catalog PRICES. A payer visiting
 * `url` starts a Checkout Session with the link's line items and options;
 * nothing about a link creates a payment on its own.
 */
export class PaymentLinksResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreatePaymentLinkParams,
    options: CreatePaymentLinkOptions = {},
  ): Promise<PaymentLink> {
    return this.client.request<PaymentLink>('POST', '/v1/payment_links', {
      body: params,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<PaymentLink> {
    return this.client.request<PaymentLink>('GET', `/v1/payment_links/${encodeURIComponent(id)}`, {
      query: { expand: params.expand },
    });
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
   * Update a link — `POST`, as every update on this API is. The line items
   * are fixed once shared; `active: false` stops new sessions starting.
   * `metadata` is a patch (`''` removes a key).
   */
  update(id: string, params: UpdatePaymentLinkParams): Promise<PaymentLink> {
    return this.client.request<PaymentLink>('POST', `/v1/payment_links/${encodeURIComponent(id)}`, {
      body: params,
    });
  }

  /** The link's line items; `expand: ['data.price']` returns the prices. */
  listLineItems(id: string, params: ListParams = {}): ApiListPromise<CheckoutLineItem> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<PaymentLinkLineItemList>(
          'GET',
          `/v1/payment_links/${encodeURIComponent(id)}/line_items`,
          { query: listQuery(page) },
        ),
      params,
    );
  }
}
