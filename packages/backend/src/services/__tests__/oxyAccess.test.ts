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
import express, { type Request } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import {
  authorizeApplication,
  type CallerClient,
  createOxyAccess,
  type OxyAccess,
  OxyAccessError,
} from '../oxyAccess';

/**
 * oxy-api stand-in on LOOPBACK, reached through the real Oxy SDK client.
 *
 * Loopback is the point: in production `api.oxy.so` resolves, inside the VPC,
 * to the internal load balancer — a private address — and the SSRF guard the
 * check once went through refused it, so every owner was told they were not
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

const application = (extra: Record<string, unknown> = {}) => ({
  application: {
    _id: 'app',
    status: 'active',
    ownerAccountId: 'acct_owner',
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

/** A request as `requireOxyUser` leaves it. */
function signedIn(userId = 'user_1', extra: Partial<OxyAuthRequest> = {}): Request {
  return Object.assign(Object.create(express.request) as Request, {
    userId,
    accessToken: BEARER,
    sessionId: `sess_${userId}`,
    ...extra,
  });
}

/** What a check threw, or `null` when it answered. */
async function failure(check: Promise<unknown>): Promise<string | null> {
  try {
    await check;
    return null;
  } catch (error) {
    if (error instanceof OxyAccessError) return error.reason;
    throw error;
  }
}

let warn: ReturnType<typeof spyOn>;
let access: OxyAccess;

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
  // A fresh instance per test: its cache never crosses tests.
  access = createOxyAccess({ oxyApiUrl });
});
afterEach(() => {
  warn.mockRestore();
});

describe('application access through the Oxy SDK, oxy-api on a private address', () => {
  test("a member's permissions, owner account and status, the caller's bearer forwarded", async () => {
    handler = answer(200, application());
    expect(await access.application(signedIn(), 'app_1')).toEqual({
      applicationId: 'app_1',
      ownerAccountId: 'acct_owner',
      permissions: ['app:read', 'billing:read'],
      official: false,
      active: true,
    });
    expect(seen).toEqual([{ url: '/applications/app_1', authorization: `Bearer ${BEARER}` }]);
  });

  test('an answer is reused for a read within the TTL; `fresh` (every write) asks again', async () => {
    handler = answer(200, application());
    await access.application(signedIn(), 'app_1');
    await access.application(signedIn(), 'app_1');
    expect(seen).toHaveLength(1);
    await access.application(signedIn(), 'app_1', { fresh: true });
    expect(seen).toHaveLength(2);
  });

  test('the cache is per (user, session): another person, or another session, asks again', async () => {
    handler = answer(200, application());
    await access.application(signedIn('user_a'), 'app_1');
    await access.application(signedIn('user_b'), 'app_1');
    await access.application(signedIn('user_a', { sessionId: 'sess_other' }), 'app_1');
    expect(seen).toHaveLength(3);
  });

  test('an official application is reported as such; an archived one as inactive', async () => {
    handler = answer(200, application({ type: 'first_party', status: 'archived' }));
    const granted = await access.application(signedIn(), 'app_1');
    expect(granted.official).toBe(true);
    expect(granted.active).toBe(false);
  });

  test.each([
    ['a null callerMembership', 200, application({ callerMembership: null })],
    ['a 403', 403, { error: 'nope', message: 'nope' }],
    ['a 404', 404, { error: 'nope', message: 'nope' }],
  ] as const)('%s is "no" — and "no" is never cached', async (_label, status, body) => {
    handler = answer(status, body);
    expect(await failure(access.application(signedIn(), 'app_1'))).toBe('denied');
    handler = answer(200, application());
    expect(await failure(access.application(signedIn(), 'app_1'))).toBeNull();
    expect(seen).toHaveLength(2);
  });

  test('a 401 asks the caller to sign in again, and is not cached', async () => {
    handler = answer(401, { error: 'Invalid session', message: 'Session not found or expired' });
    expect(await failure(access.application(signedIn(), 'app_1'))).toBe('session_required');
    handler = answer(200, application());
    expect(await failure(access.application(signedIn(), 'app_1'))).toBeNull();
  });

  test.each([
    ['a 500', 500, { error: 'boom' }],
    ['a 503', 503, { error: 'down' }],
    ['an answer off the contract', 200, { application: { callerMembership: 'yes' } }],
  ] as const)('%s is an outage, never cached as "no"', async (_label, status, body) => {
    handler = answer(status, body);
    expect(await failure(access.application(signedIn(), 'app_1'))).toBe('unavailable');
    handler = answer(200, application());
    expect(await failure(access.application(signedIn(), 'app_1'))).toBeNull();
  });

  test('oxy-api unreachable is an outage', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const down = createOxyAccess({ oxyApiUrl: deadUrl });
    expect(await failure(down.application(signedIn(), 'app_1'))).toBe('unavailable');
  });

  test('a service credential, or no session, is refused before Oxy is asked', async () => {
    handler = answer(200, application());
    expect(
      await failure(access.application(signedIn('user_1', { serviceApp: {} as never }), 'app_1')),
    ).toBe('session_required');
    expect(
      await failure(access.application(signedIn('user_1', { accessToken: undefined }), 'app_1')),
    ).toBe('session_required');
    expect(seen).toHaveLength(0);
  });
});

describe('account access', () => {
  test("an organization's kind and the caller's permissions over it", async () => {
    handler = answer(200, {
      account: {
        accountId: 'org_1',
        kind: 'organization',
        relationship: 'member',
        callerMembership: { role: 'editor', permissions: ['account:read', 'apps:update'] },
      },
    });
    expect(await access.account(signedIn(), 'org_1')).toEqual({
      accountId: 'org_1',
      kind: 'organization',
      permissions: ['account:read', 'apps:update'],
    });
    expect(seen).toEqual([{ url: '/accounts/org_1', authorization: `Bearer ${BEARER}` }]);
  });

  test('their own account carries no membership row and is still theirs', async () => {
    handler = answer(200, {
      account: { accountId: 'me', kind: 'personal', relationship: 'self', callerMembership: null },
    });
    expect((await access.account(signedIn(), 'me')).kind).toBe('personal');
  });

  test('no membership of someone else is "no"', async () => {
    handler = answer(200, {
      account: {
        accountId: 'x',
        kind: 'organization',
        relationship: 'none',
        callerMembership: null,
      },
    });
    expect(await failure(access.account(signedIn(), 'x'))).toBe('denied');
  });
});

describe('the per-check client', () => {
  test('one client per check, for the caller, disposed after it', async () => {
    const made: { token: string; baseURL: string; disposed: boolean }[] = [];
    const clientFor = (token: string, baseURL: string): CallerClient => {
      const entry = { token, baseURL, disposed: false };
      made.push(entry);
      return {
        apps: { get: async () => application().application },
        accounts: { get: async () => ({}) },
        dispose: () => {
          entry.disposed = true;
        },
      };
    };
    await createOxyAccess({ clientFor, oxyApiUrl: 'https://oxy.test' }).application(
      signedIn(),
      'app_1',
    );
    expect(made).toEqual([{ token: BEARER, baseURL: 'https://oxy.test', disposed: true }]);
  });

  test('TTL expiry asks Oxy again instead of serving a stale answer', async () => {
    let calls = 0;
    const clientFor = (): CallerClient => ({
      apps: {
        get: async () => {
          calls += 1;
          return application({ callerMembership: calls === 1 ? { permissions: [] } : null })
            .application;
        },
      },
      accounts: { get: async () => ({}) },
    });
    const short = createOxyAccess({ clientFor, ttlMs: 10 });
    expect(await failure(short.application(signedIn(), 'app_1'))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await failure(short.application(signedIn(), 'app_1'))).toBe('denied');
    expect(calls).toBe(2);
  });
});

describe('authorizeApplication: the canonical HTTP answer', () => {
  const stub = (
    result: () => Promise<never> | ReturnType<OxyAccess['application']>,
  ): OxyAccess => ({
    application: result,
    account: () => Promise.reject(new Error('not used')),
  });
  const granted = (permissions: string[]) =>
    stub(async () => ({
      applicationId: 'app_1',
      ownerAccountId: 'acct',
      permissions,
      official: false,
      active: true,
    }));

  async function respond(gate: OxyAccess, action: Parameters<typeof authorizeApplication>[3]) {
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { userId: 'user_1', accessToken: BEARER });
      next();
    });
    app.all('/', async (req, res) => {
      if (await authorizeApplication(req, res, 'app_1', action, gate)) res.status(204).end();
    });
    const listening = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/`;
      const res = await fetch(url, { method: 'POST' });
      const body = res.status === 204 ? null : ((await res.json()) as { error: { code: string } });
      return { status: res.status, code: body?.error.code };
    } finally {
      listening.close();
    }
  }

  test.each([
    ['session_required', 401, 'session_invalid'],
    ['denied', 403, 'application_membership_required'],
    ['unavailable', 503, 'membership_unavailable'],
  ] as const)('%s → %d %s', async (reason, status, code) => {
    const failing = stub(() => Promise.reject(new OxyAccessError(reason, 'x')));
    expect(await respond(failing, 'read')).toEqual({ status, code });
  });

  test('a member without the action’s permission is refused, naming the code', async () => {
    expect(await respond(granted(['app:read']), 'money')).toEqual({
      status: 403,
      code: 'permission_required',
    });
    expect(await respond(granted(['app:read', 'billing:manage']), 'money')).toEqual({
      status: 204,
      code: undefined,
    });
  });

  test('billing:manage contains billing:read; nothing else is implied', async () => {
    expect((await respond(granted(['app:read', 'billing:manage']), 'taxRead')).status).toBe(204);
    expect((await respond(granted(['app:read', 'app:update']), 'webhooks')).status).toBe(403);
  });
});
