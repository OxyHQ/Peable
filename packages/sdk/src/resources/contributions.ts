import {
  contributionLinkSchema,
  contributionListSchema,
  contributionCollectionListSchema,
  createContributionSchema,
  contributionOperationKeySchema,
  type ContributionCollection,
  type ContributionCollectionList,
  type ContributionLink,
  type ContributionList,
  type CreateContribution,
} from '@peable.to/contracts/contributions';
import type { ListParams } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';
export interface ContributionScope {
  organizationId: string;
  applicationId: string;
  environment: 'development' | 'staging' | 'production';
}
/** The list parameters every list takes (`starting_after`/`ending_before`/`created`/`limit`). */
export type ContributionPage = Omit<ListParams, 'expand'>;
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
  /** The organization's links, newest first; await one page or iterate them all. */
  list(
    scope: ContributionScope,
    page: ContributionPage = {},
  ): ApiListPromise<ContributionLink, ContributionList> {
    return listPromise(
      async (params: ContributionPage) =>
        contributionListSchema.parse(
          await this.client.request('GET', this.path(scope), {
            query: listQuery(params, { environment: scope.environment }),
          }),
        ),
      page,
    );
  }
  /** Enable or disable a link — `POST`, as every update on this API is. */
  async setActive(scope: ContributionScope, id: string, active: boolean) {
    return contributionLinkSchema.parse(
      await this.client.request('POST', `${this.path(scope)}/${encodeURIComponent(id)}`, {
        query: { environment: scope.environment },
        body: { active },
      }),
    );
  }
  /** The payments made through one link, newest first. */
  collections(
    scope: ContributionScope,
    id: string,
    page: ContributionPage = {},
  ): ApiListPromise<ContributionCollection, ContributionCollectionList> {
    return listPromise(
      async (params: ContributionPage) =>
        contributionCollectionListSchema.parse(
          await this.client.request(
            'GET',
            `${this.path(scope)}/${encodeURIComponent(id)}/collections`,
            { query: listQuery(params, { environment: scope.environment }) },
          ),
        ),
      page,
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
} from '@peable.to/contracts/contributions';
