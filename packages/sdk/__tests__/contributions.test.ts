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
  amount: '100000000',
  currency: 'FAIR',
  network: 'testnet',
  active: true,
  url: 'https://checkout.peable.to/l/link_one',
  createdAt: new Date().toISOString(),
  contribution: {
    organizationId: scope.organizationId,
    purpose: 'Garden',
    amountMode: 'fixed',
    expiresAt: null,
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
    { purpose: 'Garden', amountMode: 'fixed', amount: '100000000', currency: 'FAIR' },
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
test('iterator rejects a repeated cursor instead of looping', async () => {
  const client = new ContributionsResource({
    request: async <T>() => ({ items: [link], nextCursor: 'same' }) as T,
  });
  await expect(
    (async () => {
      for await (const _row of client.iterate(scope)) {
        /* drain */
      }
    })(),
  ).rejects.toThrow('Repeated contribution cursor');
});
