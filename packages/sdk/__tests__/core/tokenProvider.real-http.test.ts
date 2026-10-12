// `new Peable({ tokenProvider })` — a workload that already holds an Oxy
// identity hands the SDK its tokens instead of a key pair. Exercised through
// the real constructor and a real socket, so the assertions are about what
// reaches the Gateway, not about which internal function was called.
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type RequestListener, type Server } from 'node:http';
import { PeableAuthenticationError } from '../../src/core/errors';
import type { ServiceTokenProvider } from '../../src/core/serviceToken';
import { Peable } from '../../src/index';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return `http://127.0.0.1:${address.port}`;
}

/** Hands out `token-<n>`, where `n` counts `invalidate()` calls. */
function countingProvider(): { provider: ServiceTokenProvider; invalidations: () => number } {
  let generation = 0;
  return {
    provider: {
      getToken: async () => `token-${generation}`,
      invalidate: () => {
        generation += 1;
      },
    },
    invalidations: () => generation,
  };
}

interface Seen {
  path: string | undefined;
  authorization: string | undefined;
}

/** A Gateway that answers 401 to the listed bearers and 200 to anything else. */
async function gateway(rejected: string[]): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const url = await listen((request, response) => {
    request.resume();
    const authorization = request.headers.authorization;
    seen.push({ path: request.url, authorization });
    const status = rejected.includes(authorization ?? '') ? 401 : 200;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify(
        status === 401
          ? { error: { type: 'authentication_error', message: 'Invalid token' } }
          : { id: 'pi_1', object: 'payment_intent' },
      ),
    );
  });
  return { url, seen };
}

describe('Peable with a caller-supplied tokenProvider', () => {
  test('sends the provider token as the bearer and never mints one itself', async () => {
    const { url, seen } = await gateway([]);
    const { provider, invalidations } = countingProvider();
    // oxyApiUrl points at the same server: a mint attempt would be recorded.
    const peable = new Peable({ tokenProvider: provider, baseURL: url, oxyApiUrl: url });

    await expect(peable.paymentIntents.retrieve('pi_1')).resolves.toMatchObject({ id: 'pi_1' });

    expect(seen).toEqual([{ path: '/v1/payment_intents/pi_1', authorization: 'Bearer token-0' }]);
    expect(invalidations()).toBe(0);
  });

  test('a 401 invalidates the provider once and retries with the fresh token', async () => {
    const { url, seen } = await gateway(['Bearer token-0']);
    const { provider, invalidations } = countingProvider();
    const peable = new Peable({ tokenProvider: provider, baseURL: url });

    await expect(peable.paymentIntents.retrieve('pi_1')).resolves.toMatchObject({ id: 'pi_1' });

    expect(seen.map((request) => request.authorization)).toEqual([
      'Bearer token-0',
      'Bearer token-1',
    ]);
    expect(invalidations()).toBe(1);
  });

  test('a second 401 surfaces as an authentication error after exactly one retry', async () => {
    const { url, seen } = await gateway(['Bearer token-0', 'Bearer token-1']);
    const { provider, invalidations } = countingProvider();
    const peable = new Peable({ tokenProvider: provider, baseURL: url });

    await expect(peable.paymentIntents.retrieve('pi_1')).rejects.toBeInstanceOf(
      PeableAuthenticationError,
    );

    expect(seen).toHaveLength(2);
    expect(invalidations()).toBe(1);
  });

  test('a provider that cannot produce a token fails before reaching the Gateway', async () => {
    const { url, seen } = await gateway([]);
    const peable = new Peable({
      tokenProvider: {
        getToken: async () => {
          throw new Error('no Oxy identity');
        },
        invalidate: () => {},
      },
      baseURL: url,
    });

    await expect(peable.paymentIntents.retrieve('pi_1')).rejects.toThrow('no Oxy identity');
    expect(seen).toHaveLength(0);
  });
});
