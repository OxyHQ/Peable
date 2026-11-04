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
import express from 'express';
import { OxyServer, type OxyApplicationAccess } from '@oxy.so/core/server';
import type { DashboardAction } from '@peable.to/contracts/vocabulary';
import { authorizeAccount, authorizeApplication, type OxyAccess } from '../oxyAccess';

/**
 * The real path: Peable's gate over `@oxy.so/core`'s `applicationAccessFor` /
 * `accountAccessFor`, against an oxy-api stand-in on LOOPBACK.
 *
 * Loopback is the point: in production `api.oxy.so` resolves, inside the VPC,
 * to the internal load balancer — a private address — and the SSRF guard the
 * check once went through refused it, so every owner was told they were not
 * a member. A check that cannot reach a private oxy-api fails these tests.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler;
let oxyApi: Server;
let oxyApiUrl: string;
const seen: { url?: string; authorization?: string }[] = [];

function answer(status: number, body: unknown): Handler {
  return (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

/** `GET /applications/:id` as oxy-api serializes it for a member. */
const application = (extra: Record<string, unknown> = {}, permissions = ['app:read']) => ({
  application: {
    _id: 'app_1',
    type: 'third_party',
    status: 'active',
    isOfficial: false,
    isInternal: false,
    ownerAccountId: 'acct_owner',
    callerMembership: {
      role: 'admin',
      permissions,
      source: 'account',
      ownerAccountId: 'acct_owner',
    },
    ...extra,
  },
});

/** `GET /accounts/:id` as oxy-api serializes it. */
const account = (extra: Record<string, unknown> = {}) => ({
  account: {
    accountId: 'org_1',
    kind: 'organization',
    relationship: 'member',
    callerAccess: {
      role: 'admin',
      permissions: ['account:read'],
      status: 'active',
      source: 'direct',
    },
    ...extra,
  },
});

/**
 * A JWT-shaped user bearer, as Oxy mints them. Unsigned: oxy-api — here the
 * stand-in — is what verifies it, never the gateway.
 */
function userBearer(sessionId: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ userId: 'user_jwt', sessionId, exp })}.sig`;
}
const BEARER = userBearer('sess_test');

let access: OxyAccess;
let warn: ReturnType<typeof spyOn>;

beforeAll(async () => {
  oxyApi = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => oxyApi.listen(0, '127.0.0.1', resolve));
  oxyApiUrl = `http://127.0.0.1:${(oxyApi.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => oxyApi.close(() => resolve()));
});
beforeEach(() => {
  seen.length = 0;
  warn = spyOn(console, 'warn').mockImplementation(() => undefined);
  // A fresh server per test: its answer cache never crosses tests.
  access = new OxyServer({ baseURL: oxyApiUrl, enableRetry: false });
});
afterEach(() => {
  warn.mockRestore();
});

interface Caller {
  readonly userId?: string;
  readonly sessionId?: string;
  readonly service?: boolean;
}

/** One request through a gate, as `requireOxyUser` would leave it. */
async function through(
  gate: (req: express.Request, res: express.Response) => Promise<unknown>,
  method: 'GET' | 'POST' = 'GET',
  caller: Caller = {},
): Promise<{ status: number; code?: string; granted?: unknown }> {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, {
      userId: caller.userId ?? 'user_1',
      sessionId: caller.sessionId ?? 'sess_1',
      accessToken: BEARER,
      ...(caller.service ? { serviceApp: { appId: 'svc' } } : {}),
    });
    next();
  });
  app.all('/', async (req, res) => {
    const granted = await gate(req, res);
    if (granted) res.status(200).json({ granted });
  });
  const listening = app.listen(0);
  try {
    const url = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/`;
    const res = await fetch(url, { method });
    const body = (await res.json()) as { error?: { code: string }; granted?: unknown };
    return { status: res.status, code: body.error?.code, granted: body.granted };
  } finally {
    listening.close();
  }
}

const gateFor = (action: DashboardAction) => (req: express.Request, res: express.Response) =>
  authorizeApplication(req, res, 'app_1', action, access);

describe('application access through @oxy.so/core, oxy-api on a private address', () => {
  test("a member's permissions, owner account, status and trust, the caller's bearer forwarded", async () => {
    handler = answer(200, application());
    const { status, granted } = await through(gateFor('read'));
    expect(status).toBe(200);
    expect(granted).toMatchObject({
      applicationId: 'app_1',
      ownerAccountId: 'acct_owner',
      permissions: ['app:read'],
      official: false,
      status: 'active',
    });
    expect(seen).toEqual([{ url: '/applications/app_1', authorization: `Bearer ${BEARER}` }]);
  });

  test('an answer is reused for a read; a write always asks again', async () => {
    handler = answer(200, application({}, ['app:read', 'app:update']));
    await through(gateFor('read'));
    await through(gateFor('read'));
    expect(seen).toHaveLength(1);
    expect((await through(gateFor('configure'), 'POST')).status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  test('another session asks again', async () => {
    handler = answer(200, application());
    await through(gateFor('read'));
    await through(gateFor('read'), 'GET', { sessionId: 'sess_other' });
    expect(seen).toHaveLength(2);
  });

  test("Oxy's own application is official by Oxy's trust rule, a suspended one says so", async () => {
    handler = answer(200, application({ type: 'first_party', status: 'suspended' }));
    const { granted } = await through(gateFor('read'));
    expect((granted as OxyApplicationAccess).official).toBe(true);
    expect((granted as OxyApplicationAccess).status).toBe('suspended');
  });

  test.each([
    ['a 403', 403],
    ['a 404', 404],
  ] as const)('%s is "no" — and "no" is never cached', async (_label, status) => {
    handler = answer(status, { error: { code: 'forbidden', message: 'nope' } });
    expect(await through(gateFor('read'))).toMatchObject({
      status: 403,
      code: 'application_membership_required',
    });
    handler = answer(200, application());
    expect((await through(gateFor('read'))).status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  test('a 401 asks the caller to sign in again, and is not cached', async () => {
    handler = answer(401, { error: { code: 'invalid_session', message: 'expired' } });
    expect(await through(gateFor('read'))).toMatchObject({ status: 401, code: 'session_invalid' });
    handler = answer(200, application());
    expect((await through(gateFor('read'))).status).toBe(200);
  });

  test.each([
    ['a 500', 500, { error: 'boom' }],
    ['a 503', 503, { error: 'down' }],
    ['an answer off the contract', 200, { application: { _id: 'app_1', callerMembership: 'yes' } }],
  ] as const)('%s is an outage (503), never cached as "no"', async (_label, status, body) => {
    handler = answer(status, body);
    expect(await through(gateFor('read'))).toMatchObject({
      status: 503,
      code: 'membership_unavailable',
    });
    handler = answer(200, application());
    expect((await through(gateFor('read'))).status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  test('oxy-api unreachable is an outage', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    access = new OxyServer({ baseURL: deadUrl, enableRetry: false });
    expect(await through(gateFor('read'))).toMatchObject({
      status: 503,
      code: 'membership_unavailable',
    });
  });

  test('a service credential is refused before Oxy is asked', async () => {
    handler = answer(200, application());
    expect(await through(gateFor('read'), 'GET', { service: true })).toMatchObject({
      status: 401,
      code: 'session_invalid',
    });
    expect(seen).toHaveLength(0);
  });

  test('a member without the action’s permission is refused, naming the code', async () => {
    handler = answer(200, application({}, ['app:read']));
    expect(await through(gateFor('money'), 'POST')).toMatchObject({
      status: 403,
      code: 'permission_required',
    });
    handler = answer(200, application({}, ['app:read', 'billing:manage']));
    expect((await through(gateFor('money'), 'POST')).status).toBe(200);
  });

  test('billing:manage contains billing:read; nothing else is implied', async () => {
    handler = answer(200, application({}, ['app:read', 'billing:manage']));
    expect((await through(gateFor('taxRead'))).status).toBe(200);
    handler = answer(200, application({}, ['app:read', 'app:update']));
    expect((await through(gateFor('webhooks'), 'POST')).status).toBe(403);
  });
});

describe('account access', () => {
  const accountGate = (req: express.Request, res: express.Response) =>
    authorizeAccount(req, res, 'org_1', access);

  test("an organization's kind and the caller's permissions over it", async () => {
    handler = answer(200, account());
    const { status, granted } = await through(accountGate);
    expect(status).toBe(200);
    expect(granted).toMatchObject({
      accountId: 'org_1',
      kind: 'organization',
      permissions: ['account:read'],
    });
    expect(seen).toEqual([{ url: '/accounts/org_1', authorization: `Bearer ${BEARER}` }]);
  });

  test('a refusal is 403, an outage 503', async () => {
    handler = answer(403, { error: { code: 'forbidden', message: 'nope' } });
    expect(await through(accountGate)).toMatchObject({
      status: 403,
      code: 'account_membership_required',
    });
    handler = answer(502, { error: 'bad gateway' });
    expect(await through(accountGate)).toMatchObject({
      status: 503,
      code: 'membership_unavailable',
    });
  });
});
