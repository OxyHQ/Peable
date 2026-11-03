import type {
  CancelSetupIntentParams,
  CreateSetupIntentParams,
  ExpandParams,
  List,
  ListParams,
  SetupIntent,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * SetupIntents (`seti_…`, ADR 0016) — saving a card to a customer without
 * charging it. Create one server-side, hand its `client_secret` to the payer's
 * browser, and the provider's Elements collect and confirm the card; on success
 * the SetupIntent carries the new `pm_…` (`payment_method`), and
 * `setup_intent.succeeded` / `payment_method.attached` are delivered.
 */
export interface SetupIntentListParams extends ListParams {
  /** Only this customer's (`cus_…`). */
  customer?: string;
}

export type SetupIntentList = List<SetupIntent>;

export class SetupIntentsResource {
  constructor(private readonly client: RestClient) {}

  /** `customer` is required by the gateway: a saved card always belongs to someone. */
  create(
    params: CreateSetupIntentParams & ExpandParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<SetupIntent> {
    return this.client.request<SetupIntent>('POST', '/v1/setup_intents', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Read back — reconciled with the provider while it is not finished. */
  retrieve(id: string, params: ExpandParams = {}): Promise<SetupIntent> {
    return this.client.request<SetupIntent>('GET', `/v1/setup_intents/${encodeURIComponent(id)}`, {
      query: { expand: params.expand },
    });
  }

  list(params: SetupIntentListParams = {}): ApiListPromise<SetupIntent> {
    return listPromise(
      (page: SetupIntentListParams) =>
        this.client.request<SetupIntentList>('GET', '/v1/setup_intents', {
          query: listQuery(page, { customer: page.customer }),
        }),
      params,
    );
  }

  cancel(
    id: string,
    params: CancelSetupIntentParams & ExpandParams = {},
    options: { idempotencyKey?: string } = {},
  ): Promise<SetupIntent> {
    return this.client.request<SetupIntent>(
      'POST',
      `/v1/setup_intents/${encodeURIComponent(id)}/cancel`,
      { body: params, idempotencyKey: options.idempotencyKey },
    );
  }
}
