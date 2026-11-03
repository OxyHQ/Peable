import type {
  CreateCustomerParams,
  Customer,
  DeletedCustomer,
  ExpandParams,
  List,
  ListParams,
  UpdateCustomerParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * Customers (`cus_…`, ADR 0016) — Orbit's own object. The provider customer a
 * saved card belongs to is an internal binding and never appears here.
 */
export interface CustomerListParams extends ListParams {
  /** Exact match. */
  email?: string;
}

export type CustomerList = List<Customer>;

export class CustomersResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateCustomerParams & ExpandParams = {},
    options: { idempotencyKey?: string } = {},
  ): Promise<Customer> {
    return this.client.request<Customer>('POST', '/v1/customers', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** A deleted customer answers `{ id, object: 'customer', deleted: true }`. */
  retrieve(id: string, params: ExpandParams = {}): Promise<Customer | DeletedCustomer> {
    return this.client.request<Customer | DeletedCustomer>(
      'GET',
      `/v1/customers/${encodeURIComponent(id)}`,
      { query: { expand: params.expand } },
    );
  }

  /** `POST`, as every update on this API. `''` clears a field; `metadata` is a patch. */
  update(
    id: string,
    params: UpdateCustomerParams & ExpandParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<Customer> {
    return this.client.request<Customer>('POST', `/v1/customers/${encodeURIComponent(id)}`, {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Delete: a tombstone, and every saved payment method of the customer detached. */
  del(id: string): Promise<DeletedCustomer> {
    return this.client.request<DeletedCustomer>(
      'DELETE',
      `/v1/customers/${encodeURIComponent(id)}`,
    );
  }

  /** Your live customers, newest first; a page promise and an async iterable. */
  list(params: CustomerListParams = {}): ApiListPromise<Customer> {
    return listPromise(
      (page: CustomerListParams) =>
        this.client.request<CustomerList>('GET', '/v1/customers', {
          query: listQuery(page, { email: page.email }),
        }),
      params,
    );
  }
}
