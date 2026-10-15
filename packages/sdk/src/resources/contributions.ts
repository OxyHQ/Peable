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
  async list(scope: ContributionScope, page: { cursor?: string; limit?: number } = {}) {
    return contributionListSchema.parse(
      await this.client.request('GET', this.path(scope), {
        query: { environment: scope.environment, ...page },
      }),
    );
  }
  async *iterate(scope: ContributionScope) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.list(scope, cursor ? { cursor } : {});
      yield* page.items;
      cursor = page.nextCursor ?? undefined;
      if (cursor) {
        if (seen.has(cursor)) throw new Error('Repeated contribution cursor');
        seen.add(cursor);
      }
    } while (cursor);
  }
  async setActive(scope: ContributionScope, id: string, active: boolean) {
    return contributionLinkSchema.parse(
      await this.client.request('PATCH', `${this.path(scope)}/${encodeURIComponent(id)}`, {
        query: { environment: scope.environment },
        body: { active },
      }),
    );
  }
  async collections(
    scope: ContributionScope,
    id: string,
    page: { cursor?: string; limit?: number } = {},
  ) {
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
} from '@peable.to/contracts';
