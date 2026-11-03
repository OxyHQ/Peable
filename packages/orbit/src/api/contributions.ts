import {
  type ContributionCollectionList,
  type ContributionLink,
  type ContributionList,
  type CreateContribution,
  contributionCollectionListSchema,
  contributionLinkSchema,
  contributionListSchema,
  contributionOperationKeySchema,
  createContributionSchema,
} from '@peable.to/contracts/contributions';
import type { ListParams } from '@peable.to/shared-types';
import type { OrbitTransport } from './transport';

/**
 * Which organization's links, for which application and environment. Human
 * management: the person's Oxy session over Orbit's transport, never a
 * merchant service token — which is why this lives in Orbit and not in the
 * server SDK.
 */
export interface ContributionScope {
  organizationId: string;
  applicationId: string;
  environment: 'development' | 'staging' | 'production';
}

/** The list parameters every list takes (`starting_after`/`ending_before`/`created`/`limit`). */
export type ContributionPage = Omit<ListParams, 'expand'>;

export interface ContributionsApi {
  /** Create a link under the caller's own operation key, so a retry converges. */
  create(
    scope: ContributionScope,
    body: CreateContribution,
    idempotencyKey: string,
  ): Promise<ContributionLink>;
  /** One page of the organization's links, newest first. */
  list(scope: ContributionScope, page?: ContributionPage): Promise<ContributionList>;
  /** Enable or disable a link — `POST`, as every update on this API is. */
  setActive(scope: ContributionScope, id: string, active: boolean): Promise<ContributionLink>;
  /** One page of the payments made through a link, newest first. */
  collections(
    scope: ContributionScope,
    id: string,
    page?: ContributionPage,
  ): Promise<ContributionCollectionList>;
}

function pathOf(scope: ContributionScope): string {
  return `/v1/organizations/${encodeURIComponent(scope.organizationId)}/applications/${encodeURIComponent(scope.applicationId)}/contributions`;
}

function pageQuery(scope: ContributionScope, page: ContributionPage) {
  return {
    environment: scope.environment,
    limit: page.limit,
    starting_after: page.starting_after,
    ending_before: page.ending_before,
    created: page.created,
  };
}

/**
 * The contribution routes over Orbit's transport, every request and answer
 * checked against `@peable.to/contracts` — so a list keeps its `has_more`, a
 * refusal keeps the gateway's message and request id, and an answer the
 * contract does not accept is an error rather than a half-rendered screen.
 */
export function createContributionsApi(transport: OrbitTransport): ContributionsApi {
  return {
    async create(scope, body, idempotencyKey) {
      return contributionLinkSchema.parse(
        await transport.request('POST', pathOf(scope), {
          query: { environment: scope.environment },
          body: createContributionSchema.parse(body),
          idempotencyKey: contributionOperationKeySchema.parse(idempotencyKey),
        }),
      );
    },
    async list(scope, page = {}) {
      return contributionListSchema.parse(
        await transport.request('GET', pathOf(scope), { query: pageQuery(scope, page) }),
      );
    },
    async setActive(scope, id, active) {
      return contributionLinkSchema.parse(
        await transport.request('POST', `${pathOf(scope)}/${encodeURIComponent(id)}`, {
          query: { environment: scope.environment },
          body: { active },
        }),
      );
    },
    async collections(scope, id, page = {}) {
      return contributionCollectionListSchema.parse(
        await transport.request('GET', `${pathOf(scope)}/${encodeURIComponent(id)}/collections`, {
          query: pageQuery(scope, page),
        }),
      );
    },
  };
}
