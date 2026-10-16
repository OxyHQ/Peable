import { z } from 'zod';
import {
  createContributionSchema,
  contributionLinkSchema,
  contributionListSchema,
  contributionCollectionListSchema,
  contributionPatchSchema,
} from './index';
const path = '/v1/organizations/{organizationId}/applications/{applicationId}/contributions';
export const contributionRoutes = [
  {
    method: 'post',
    path,
    operationId: 'createContribution',
    body: createContributionSchema,
    response: contributionLinkSchema,
    status: 201,
  },
  {
    method: 'get',
    path,
    operationId: 'listContributions',
    response: contributionListSchema,
    status: 200,
  },
  {
    method: 'patch',
    path: `${path}/{id}`,
    operationId: 'setContributionActive',
    body: contributionPatchSchema,
    response: contributionLinkSchema,
    status: 200,
  },
  {
    method: 'get',
    path: `${path}/{id}/collections`,
    operationId: 'listContributionCollections',
    response: contributionCollectionListSchema,
    status: 200,
  },
] as const;
export function contributionOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of contributionRoutes) {
    paths[route.path] ??= {};
    const parameters: unknown[] = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      in: 'path',
      name: match[1],
      required: true,
      schema: { type: 'string' },
    }));
    parameters.push({
      in: 'query',
      name: 'environment',
      required: true,
      schema: { type: 'string', enum: ['development', 'staging', 'production'] },
    });
    if (route.method === 'get')
      parameters.push(
        {
          in: 'query',
          name: 'limit',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        { in: 'query', name: 'cursor', schema: { type: 'string' } },
      );
    if (route.method === 'post')
      parameters.push({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      });
    paths[route.path][route.method] = {
      operationId: route.operationId,
      security: [{ oxySession: [] }],
      parameters,
      ...('body' in route
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: z.toJSONSchema(route.body) } },
            },
          }
        : {}),
      responses: {
        [route.status]: {
          description: 'Success',
          content: { 'application/json': { schema: z.toJSONSchema(route.response) } },
        },
        default: {
          description: 'Peable error envelope; HTTP status identifies failure',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: {
                  error: {
                    type: 'object',
                    required: ['type', 'message'],
                    properties: { type: { type: 'string' }, message: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Peable organization contributions',
      version: '0.1.0',
      description:
        'One-off links. Human Oxy session for management; existing /v1/payment_links/{id}/public and /payment_intent remain anonymous. Fixed/free amounts use FAIR base units (8 decimals); the registered merchant determines the network. Refunds cannot be created by the watch-only gateway. No recurring billing.',
    },
    servers: [{ url: 'https://api.peable.to' }],
    components: { securitySchemes: { oxySession: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}
