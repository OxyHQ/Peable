import { test, expect } from 'bun:test';
import { ContributionsResource } from '../src/resources/contributions';
import type { RestClientRequestOptions } from '../src/core/client';
const scope = {
  organizationId: 'org/one',
  applicationId: 'app',
  environment: 'development' as const,
};
const link = {
  id: 'link_one',
  object: 'payment_link',
  amount: '100000000',
  currency: 'FAIR',
  network: 'testnet',
  active: true,
  url: 'https://checkout.peable.to/l/link_one',
  created: Math.floor(Date.now() / 1000),
  contribution: {
    organization_id: scope.organizationId,
    purpose: 'Garden',
    amount_mode: 'fixed',
    expires_at: null,
  },
};
test('owning SDK validates and scopes organization operations with caller operation keys', async () => {
  const calls: { method: string; path: string; options?: RestClientRequestOptions }[] = [];
  const client = new ContributionsResource({
    request: async <T>(method: string, path: string, options?: RestClientRequestOptions) => {
      calls.push({ method, path, options });
      return link as T;
    },
  });
  const key = crypto.randomUUID();
  await client.create(
    scope,
    { purpose: 'Garden', amount_mode: 'fixed', amount: '100000000', currency: 'FAIR' },
    key,
  );
  expect(calls[0]?.path).toContain('/org%2Fone/');
  expect(calls[0]?.options?.idempotencyKey).toBe(key);
  expect(calls[0]?.options?.query?.environment).toBe('development');
});
test('SDK refuses a provider response that changes rail currency', async () => {
  const client = new ContributionsResource({
    request: async <T>() => ({ ...link, currency: 'EUR' }) as T,
  });
  await expect(client.setActive(scope, 'link_one', false)).rejects.toThrow();
});
test('list() auto-pages by starting_after until has_more is false', async () => {
  const second = { ...link, id: 'link_two' };
  const queries: unknown[] = [];
  const client = new ContributionsResource({
    request: async <T>(_method: string, _path: string, options?: RestClientRequestOptions) => {
      queries.push(options?.query);
      const after = options?.query?.starting_after;
      return (
        after === undefined
          ? { object: 'list', data: [link], has_more: true, url: '/x' }
          : { object: 'list', data: [second], has_more: false, url: '/x' }
      ) as T;
    },
  });
  const ids: string[] = [];
  for await (const row of client.list(scope)) ids.push(row.id);
  expect(ids).toEqual(['link_one', 'link_two']);
  expect(
    queries.map((query) =>
      Object.fromEntries(Object.entries(query as object).filter(([, v]) => v !== undefined)),
    ),
  ).toEqual([
    { environment: 'development' },
    { environment: 'development', starting_after: 'link_one' },
  ]);
});
test('auto-pagination rejects a repeated page instead of looping', async () => {
  const client = new ContributionsResource({
    request: async <T>() => ({ object: 'list', data: [link], has_more: true, url: '/x' }) as T,
  });
  await expect(
    (async () => {
      for await (const _row of client.list(scope)) {
        /* drain */
      }
    })(),
  ).rejects.toThrow('Pagination did not advance');
});
test('setActive updates with POST — there is no PATCH', async () => {
  const methods: string[] = [];
  const client = new ContributionsResource({
    request: async <T>(method: string) => {
      methods.push(method);
      return link as T;
    },
  });
  await client.setActive(scope, 'link_one', false);
  expect(methods).toEqual(['POST']);
});
