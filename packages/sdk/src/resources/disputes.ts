import type {
  Dispute,
  ExpandParams,
  List,
  ListDisputesParams,
  ListParams,
  UpdateDisputeParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

export type DisputeList = List<Dispute>;

export interface DisputeListParams extends ListParams, ListDisputesParams {}

function path(id: string): string {
  return `/v1/disputes/${encodeURIComponent(id)}`;
}

/**
 * Disputes (`dp_…`): read them, stage a response, submit it once, or accept.
 *
 * A dispute is opened by the card NETWORK, so there is nothing to create.
 *
 * ## Drafts live at the provider; the submission is one shot
 *
 * `update(id, { evidence })` STAGES: the text goes to the provider as a draft
 * (Peable stores none of it — it carries a customer's name, email, address and
 * correspondence), and file fields attach `file_…` ids of purpose
 * `dispute_evidence`. `update(id, { evidence, submit: true })` uploads the
 * attached files to the provider and submits everything. The network takes ONE
 * response: a second submission is refused, and so is one after
 * `evidence_details.due_by`.
 *
 * `evidence` is on the object only on a live read (`retrieve`, `update`,
 * `close`); lists and webhook events never carry it, because events are stored.
 */
export class DisputesResource {
  constructor(private readonly client: RestClient) {}

  /** `expand: ['payment_intent', 'charge']` returns those objects instead of their ids. */
  retrieve(id: string, params: ExpandParams = {}): Promise<Dispute> {
    return this.client.request<Dispute>('GET', path(id), { query: { expand: params.expand } });
  }

  /** Every dispute, newest first — or one payment's (`payment_intent`) or one charge's (`charge`). */
  list(params: DisputeListParams = {}): ApiListPromise<Dispute> {
    return listPromise(
      (page: DisputeListParams) =>
        this.client.request<DisputeList>('GET', '/v1/disputes', {
          query: listQuery(page, { payment_intent: page.payment_intent, charge: page.charge }),
        }),
      params,
    );
  }

  /** One payment's disputes. */
  listForPaymentIntent(paymentIntentId: string, params: ListParams = {}): ApiListPromise<Dispute> {
    return listPromise(
      (page: ListParams) =>
        this.client.request<DisputeList>(
          'GET',
          `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/disputes`,
          { query: listQuery(page) },
        ),
      params,
    );
  }

  /**
   * Stage evidence (`submit` omitted or `false`), submit it (`submit: true`,
   * once), or change `metadata`. An empty string unsets a field.
   */
  update(
    id: string,
    params: UpdateDisputeParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<Dispute> {
    return this.client.request<Dispute>('POST', path(id), {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * Accept the dispute: you will not contest it, and it is `lost`. Final — a
   * closed dispute takes no evidence.
   */
  close(id: string, options: { idempotencyKey?: string } = {}): Promise<Dispute> {
    return this.client.request<Dispute>('POST', `${path(id)}/close`, {
      idempotencyKey: options.idempotencyKey,
    });
  }
}
