import {
  contributionLinkSchema,
  contributionListSchema,
  contributionCollectionListSchema,
  createContributionSchema,
  contributionOperationKeySchema,
  type CreateContribution,
} from '@peable.to/contracts';
import type { RestClient } from '../core/client';
export interface ContributionScope {
  organizationId: string;
  applicationId: string;
  environment: 'development' | 'staging' | 'production';
}
/** One page of a list: `starting_after` is the last id of the previous page. */
export interface ContributionPage {
  limit?: number;
  starting_after?: string;
}
/** Human management uses an Oxy linked-client transport; never a merchant service token. */
export class ContributionsResource {
  constructor(private readonly client: RestClient) {}
  private path(scope: ContributionScope) {
    return `/v1/organizations/${encodeURIComponent(scope.organizationId)}/applications/${encodeURIComponent(scope.applicationId)}/contributions`;
  }
  async create(scope: ContributionScope, body: CreateContribution, idempotencyKey: string) {
    return contributionLinkSchema.parse(
      await this.client.request('POST', this.path(scope), {
        query: { environment: scope.environment },
        body: createContributionSchema.parse(body),
        idempotencyKey: contributionOperationKeySchema.parse(idempotencyKey),
      }),
    );
  }
  async list(scope: ContributionScope, page: ContributionPage = {}) {
    return contributionListSchema.parse(
      await this.client.request('GET', this.path(scope), {
        query: { environment: scope.environment, ...page },
      }),
    );
  }
  async *iterate(scope: ContributionScope) {
    let startingAfter: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const page = await this.list(scope, startingAfter ? { starting_after: startingAfter } : {});
      yield* page.data;
      const last = page.data[page.data.length - 1]?.id;
      if (!page.has_more || last === undefined) return;
      if (seen.has(last)) throw new Error('Repeated contribution page');
      seen.add(last);
      startingAfter = last;
    }
  }
  async setActive(scope: ContributionScope, id: string, active: boolean) {
    return contributionLinkSchema.parse(
      await this.client.request('PATCH', `${this.path(scope)}/${encodeURIComponent(id)}`, {
        query: { environment: scope.environment },
        body: { active },
      }),
    );
  }
  async collections(scope: ContributionScope, id: string, page: ContributionPage = {}) {
    return contributionCollectionListSchema.parse(
      await this.client.request(
        'GET',
        `${this.path(scope)}/${encodeURIComponent(id)}/collections`,
        { query: { environment: scope.environment, ...page } },
      ),
    );
  }
}
export type {
  CreateContribution,
  ContributionLink,
  ContributionDetails,
  ContributionList,
  ContributionCollection,
  ContributionCollectionList,
} from '@peable.to/contracts';
