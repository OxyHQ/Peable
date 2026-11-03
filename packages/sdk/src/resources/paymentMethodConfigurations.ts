import type {
  CreatePaymentMethodConfigurationParams,
  CreatePaymentMethodDomainParams,
  ExpandParams,
  List,
  ListParams,
  ListPaymentMethodDomainsParams,
  PaymentMethodConfiguration,
  PaymentMethodDomain,
  UpdatePaymentMethodConfigurationParams,
  UpdatePaymentMethodDomainParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

export type PaymentMethodConfigurationList = List<PaymentMethodConfiguration>;
export type PaymentMethodDomainList = List<PaymentMethodDomain>;

export interface PaymentMethodDomainListParams extends ListParams, ListPaymentMethodDomainsParams {}

/**
 * Which card-rail methods your payers are offered (`pmc_…`).
 *
 * Every merchant has exactly one default configuration, used by a card
 * PaymentIntent that names none; more can be created and named with
 * `payment_method_configuration` on a PaymentIntent. Each method reports
 * `available`, your `display_preference`, and — when it cannot be offered
 * whatever you choose — an `unavailable_reason` (`provider_unsupported`,
 * `requires_card`). A method is offered on a payment only in the `currencies`
 * it lists.
 */
export class PaymentMethodConfigurationsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreatePaymentMethodConfigurationParams = {},
    options: { idempotencyKey?: string } = {},
  ): Promise<PaymentMethodConfiguration> {
    return this.client.request<PaymentMethodConfiguration>(
      'POST',
      '/v1/payment_method_configurations',
      { body: params, idempotencyKey: options.idempotencyKey },
    );
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<PaymentMethodConfiguration> {
    return this.client.request<PaymentMethodConfiguration>(
      'GET',
      `/v1/payment_method_configurations/${encodeURIComponent(id)}`,
      { query: { expand: params.expand } },
    );
  }

  /** `{ ideal: { display_preference: { preference: 'on' } } }` turns iDEAL on. */
  update(
    id: string,
    params: UpdatePaymentMethodConfigurationParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<PaymentMethodConfiguration> {
    return this.client.request<PaymentMethodConfiguration>(
      'POST',
      `/v1/payment_method_configurations/${encodeURIComponent(id)}`,
      { body: params, idempotencyKey: options.idempotencyKey },
    );
  }

  list(params: ListParams = {}): ApiListPromise<PaymentMethodConfiguration> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<PaymentMethodConfigurationList>(
          'GET',
          '/v1/payment_method_configurations',
          { query: listQuery(page) },
        ),
      params,
    );
  }
}

/**
 * Web domains your payment pages are served from (`pmd_…`), registered so Apple
 * Pay and Google Pay run there. Peable's hosted checkout needs none.
 * `validate(id)` asks the wallets to check the domain again, once you fixed what
 * `apple_pay.status_details` / `google_pay.status_details` said.
 */
export class PaymentMethodDomainsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreatePaymentMethodDomainParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<PaymentMethodDomain> {
    return this.client.request<PaymentMethodDomain>('POST', '/v1/payment_method_domains', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<PaymentMethodDomain> {
    return this.client.request<PaymentMethodDomain>(
      'GET',
      `/v1/payment_method_domains/${encodeURIComponent(id)}`,
      { query: { expand: params.expand } },
    );
  }

  /** `enabled: false` stops wallets on the domain without forgetting it. */
  update(
    id: string,
    params: UpdatePaymentMethodDomainParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<PaymentMethodDomain> {
    return this.client.request<PaymentMethodDomain>(
      'POST',
      `/v1/payment_method_domains/${encodeURIComponent(id)}`,
      { body: params, idempotencyKey: options.idempotencyKey },
    );
  }

  list(params: PaymentMethodDomainListParams = {}): ApiListPromise<PaymentMethodDomain> {
    return listPromise(
      (page: PaymentMethodDomainListParams) =>
        this.client.request<PaymentMethodDomainList>('GET', '/v1/payment_method_domains', {
          query: listQuery(page, { domain_name: page.domain_name, enabled: page.enabled }),
        }),
      params,
    );
  }

  validate(id: string, options: { idempotencyKey?: string } = {}): Promise<PaymentMethodDomain> {
    return this.client.request<PaymentMethodDomain>(
      'POST',
      `/v1/payment_method_domains/${encodeURIComponent(id)}/validate`,
      { idempotencyKey: options.idempotencyKey },
    );
  }
}
