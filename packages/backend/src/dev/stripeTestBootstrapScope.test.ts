import { expect, test } from 'bun:test';
import { createBootstrapProofScope, createImmutableRuntimeCache } from './stripeTestBootstrapScope';
const opening = { status: 'created', capabilityPresent: false };
const identity = { intentId: 'pi_a', merchantId: 'merchant_a', providerObjectId: 'pi_provider_a' };
test('reuses the verified proof only within the exact bootstrap ownership binding', async () => {
  const scope = createBootstrapProofScope<number>();
  let providerReads = 0;
  const read = async () => scope.read(identity, opening) ?? ++providerReads;
  await scope.run(async () => {
    scope.remember(identity, await read());
    expect(await read()).toBe(1);
    expect(scope.read(identity, { ...opening, capabilityPresent: true })).toBeUndefined();
    for (const status of ['settled', 'failed', 'requires_action', 'expired'])
      expect(scope.read(identity, { ...opening, status })).toBeUndefined();
    expect(scope.read({ ...identity, intentId: 'pi_other' }, opening)).toBeUndefined();
    expect(scope.read({ ...identity, merchantId: 'other' }, opening)).toBeUndefined();
    expect(scope.read({ ...identity, providerObjectId: 'pi_other' }, opening)).toBeUndefined();
  });
  expect(await read()).toBe(2);
  await scope.run(async () => expect(await read()).toBe(3));
});
test('concurrent requests with even the same intent never share proof or leak after rejection', async () => {
  const scope = createBootstrapProofScope<string>();
  await Promise.all(
    ['first', 'second'].map((value) =>
      scope.run(async () => {
        scope.remember(identity, value);
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(scope.read(identity, opening)).toBe(value);
      }),
    ),
  );
  await expect(
    scope.run(async () => {
      scope.remember(identity, 'failed');
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  expect(scope.read(identity, opening)).toBeUndefined();
});
test('immutable runtime initializes once across requests and rejects ownership/configuration changes', async () => {
  const get = createImmutableRuntimeCache<object>();
  let calls = 0;
  const create = async () => {
    calls++;
    return {};
  };
  const [a, b] = await Promise.all([get('owner-a', create), get('owner-a', create)]);
  expect(a).toBe(b);
  expect(calls).toBe(1);
  await expect(get('owner-b', create)).rejects.toThrow('configuration changed');
  expect(calls).toBe(1);
});
test('a failed runtime initialization can be retried without caching an outage', async () => {
  const get = createImmutableRuntimeCache<string>();
  await expect(
    get('owner-a', async () => {
      throw new Error('network');
    }),
  ).rejects.toThrow('network');
  expect(await get('owner-a', async () => 'ready')).toBe('ready');
});
