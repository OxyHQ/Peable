import { describe, expect, it } from 'bun:test';
import { createContributionsApi } from './contributions';
import type { HttpMethod, OrbitTransport, RequestOptions } from './transport';

const scope = {
  organizationId: 'org_1',
  applicationId: 'app_1',
  environment: 'development' as const,
};

function recordingTransport(answer: unknown) {
  const calls: { method: HttpMethod; path: string; options?: RequestOptions }[] = [];
  const transport: OrbitTransport = {
    async request<T>(method: HttpMethod, path: string, options?: RequestOptions) {
      calls.push({ method, path, ...(options ? { options } : {}) });
      return answer as T;
    },
  };
  return { transport, calls };
}

describe('createContributionsApi', () => {
  it('reads a page through the SDK resource with its has_more intact', async () => {
    const { transport, calls } = recordingTransport({
      object: 'list',
      data: [],
      has_more: false,
      url: '/v1/organizations/org_1/applications/app_1/contributions',
    });
    const page = await createContributionsApi(transport).list(scope, { starting_after: 'plink_1' });
    expect(page.has_more).toBe(false);
    expect(page.url).toBe('/v1/organizations/org_1/applications/app_1/contributions');
    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/v1/organizations/org_1/applications/app_1/contributions',
        options: {
          query: { environment: 'development', starting_after: 'plink_1' },
          body: undefined,
          idempotencyKey: undefined,
        },
      },
    ]);
  });

  it('rejects a response the contract does not accept', async () => {
    const { transport } = recordingTransport([]);
    await expect(createContributionsApi(transport).list(scope)).rejects.toThrow();
  });
});
