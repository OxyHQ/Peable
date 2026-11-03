import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertAppMembership, type MembershipClientFactory } from '../appMembership';

/**
 * oxy-api stand-in on LOOPBACK, reached through the real Oxy SDK client.
 *
 * Loopback is the point: in production `api.oxy.so` resolves, inside the VPC,
 * to the internal load balancer — a private address — and the SSRF guard the
 * check used to go through refused it, so every owner was told they were not
 * a member. A check that cannot reach a private oxy-api fails these tests.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler;
let server: Server;
let oxyApiUrl: string;
const seen: { url?: string; authorization?: string }[] = [];

function answer(status: number, body: unknown): Handler {
  return (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

const member = (extra: Record<string, unknown> = {}) => ({
  application: {
    _id: 'app',
    callerMembership: { role: 'owner', permissions: ['app:read', 'billing:read'] },
    ...extra,
  },
});

/**
 * A JWT-shaped user bearer, as Oxy mints them (the SDK attaches only a token
 * whose claims it can read). Unsigned: oxy-api — here the stand-in — is what
 * verifies it, never the gateway.
 */
function userBearer(sessionId: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ userId: 'user_jwt', sessionId, exp })}.sig`;
}
const BEARER = userBearer('sess_test');

let warn: ReturnType<typeof spyOn>;
const logged = () => warn.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  oxyApiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen.length = 0;
  warn = spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

let n = 0;
/** A fresh (user, application) pair, so the module's cache never crosses tests. */
const fresh = () => {
  n += 1;
  return { userId: `user_${n}`, applicationId: `app_${n}` };
};

describe('assertAppMembership through the Oxy SDK, oxy-api on a private address', () => {
  test("a member is let in, with permissions and the owner account, the caller's bearer forwarded", async () => {
    const { userId, applicationId } = fresh();
    handler = answer(200, member({ ownerAccountId: 'acct_owner' }));
    const result = await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl });
    expect(result).toEqual({
      allowed: true,
      ownerAccountId: 'acct_owner',
      permissions: ['app:read', 'billing:read'],
      official: false,
    });
    expect(seen).toEqual([
      { url: `/applications/${applicationId}`, authorization: `Bearer ${BEARER}` },
    ]);
  });

  test('a member is cached for the TTL — the second check never reaches oxy-api', async () => {
    const { userId, applicationId } = fresh();
    handler = answer(200, member());
    await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl });
    await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl });
    expect(seen).toHaveLength(1);
  });

  test('an official application is reported as such', async () => {
    const { userId, applicationId } = fresh();
    handler = answer(200, member({ type: 'first_party' }));
    expect((await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl })).official).toBe(
      true,
    );
  });

  test('a null callerMembership is an answer: not a member, cached, no owner account', async () => {
    const { userId, applicationId } = fresh();
    handler = answer(200, { application: { callerMembership: null, ownerAccountId: 'acct' } });
    expect(await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl })).toEqual({
      allowed: false,
    });
    await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl });
    expect(seen).toHaveLength(1);
  });

  test.each([403, 404])('a %d is an answer: not a member, cached', async (status) => {
    const { userId, applicationId } = fresh();
    handler = answer(status, { error: 'nope', message: 'nope' });
    expect(await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl })).toEqual({
      allowed: false,
    });
    await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl });
    expect(seen).toHaveLength(1);
  });

  test('a 401 asks the caller to sign in again, and is not cached', async () => {
    const { userId, applicationId } = fresh();
    handler = answer(401, { error: 'Invalid session', message: 'Session not found or expired' });
    expect(await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl })).toEqual({
      allowed: false,
      unauthenticated: true,
    });
    handler = answer(200, member());
    expect((await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl })).allowed).toBe(
      true,
    );
  });

  test.each([
    ['a 500', 500, { error: 'boom' }],
    ['a 503', 503, { error: 'down' }],
    ['an answer off the contract', 200, { application: { callerMembership: 'yes' } }],
  ] as const)(
    '%s is an outage: logged, and never cached as "not a member"',
    async (_label, status, body) => {
      const { userId, applicationId } = fresh();
      handler = answer(status, body);
      expect(
        await assertAppMembership(userId, applicationId, BEARER, {
          oxyApiUrl,
          requestId: 'req_outage',
        }),
      ).toEqual({ allowed: false, unavailable: true });
      expect(logged()).toContain(`application=${applicationId}`);
      expect(logged()).toContain('request=req_outage');
      expect(logged()).not.toContain(BEARER);

      handler = answer(200, member());
      expect(
        (await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl })).allowed,
      ).toBe(true);
    },
  );

  test('oxy-api unreachable is an outage, logged, not cached', async () => {
    const { userId, applicationId } = fresh();
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    expect(
      await assertAppMembership(userId, applicationId, BEARER, {
        oxyApiUrl: deadUrl,
        requestId: 'req_down',
      }),
    ).toEqual({ allowed: false, unavailable: true });
    expect(logged()).toContain('request=req_down');

    handler = answer(200, member());
    expect((await assertAppMembership(userId, applicationId, BEARER, { oxyApiUrl })).allowed).toBe(
      true,
    );
  });
});

describe('assertAppMembership client handling', () => {
  test('builds one client per check for the caller, and disposes it', async () => {
    const { userId, applicationId } = fresh();
    const made: { token: string; baseURL: string; disposed: boolean }[] = [];
    const client: MembershipClientFactory = (token, baseURL) => {
      const entry = { token, baseURL, disposed: false };
      made.push(entry);
      return {
        apps: { get: async () => member().application },
        dispose: () => {
          entry.disposed = true;
        },
      };
    };
    await assertAppMembership(userId, applicationId, 'bearer-x', {
      client,
      oxyApiUrl: 'https://oxy.test',
    });
    expect(made).toEqual([{ token: 'bearer-x', baseURL: 'https://oxy.test', disposed: true }]);
  });

  test('TTL expiry re-checks against oxy-api instead of serving a stale entry', async () => {
    const { userId, applicationId } = fresh();
    let call = 0;
    const client: MembershipClientFactory = () => ({
      apps: {
        get: async () => {
          call += 1;
          return { callerMembership: call === 1 ? { role: 'owner' } : null };
        },
      },
    });
    const deps = { client, oxyApiUrl: 'https://oxy.test', ttlMs: 10 };
    expect((await assertAppMembership(userId, applicationId, 'b', deps)).allowed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await assertAppMembership(userId, applicationId, 'b', deps)).allowed).toBe(false);
    expect(call).toBe(2);
  });

  test('the cache is keyed per (userId, applicationId)', async () => {
    const { applicationId } = fresh();
    let call = 0;
    const client: MembershipClientFactory = () => ({
      apps: {
        get: async () => {
          call += 1;
          return member().application;
        },
      },
    });
    const deps = { client, oxyApiUrl: 'https://oxy.test' };
    await assertAppMembership('user_k1', applicationId, 'b1', deps);
    await assertAppMembership('user_k2', applicationId, 'b2', deps);
    expect(call).toBe(2);
  });
});
