import { test, expect, afterEach, describe } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { eq, sql } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { merchants } from '../../db/schema';
import {
  gatewayDb,
  resetGatewayTables,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { createMerchantsRouter } from '../merchants';
import { findMerchantByAppEnvironment } from '../../db/merchants/merchantRepository';
import { resolveMerchantDisplay } from '../../services/merchantDisplay';
import { oxyFileReferenceSyncs } from '../../db/schema';
import {
  createFakeOxyFiles,
  type FakeOxyFiles,
  referenceKey,
} from '../../__tests__/helpers/fakeOxyFiles';

const DEV_APP_ID = 'app_merch_dev';
const PROD_APP_ID = 'app_merch_prod';

function stubRequireMerchant(appId: string, environment: string): RequestHandler {
  return (req, _res, next) => {
    (req as OxyAuthRequest).serviceApp = {
      appId,
      appName: 't',
      scopes: ['payments:read', 'payments:write'],
      credentialId: 'c',
      ownerAccountId: 'owner',
      environment: environment as OxyAuthRequest['serviceApp'] extends infer T
        ? T extends { environment: infer E }
          ? E
          : never
        : never,
      tier: 'external',
    };
    next();
  };
}

interface MerchantResponse {
  id: string;
  object: string;
  oxy_app_id: string;
  environment: string;
  network: string;
  required_confirmations: number;
  display_name?: string;
  avatar_file_id?: string;
  description?: string;
  error?: { type: string; message: string };
}

async function readJson(res: Response): Promise<MerchantResponse> {
  return (await res.json()) as MerchantResponse;
}

/**
 * `Merchant.countDocuments({ oxyAppId })`'s port. A bare count has no
 * repository function — `findMerchantByAppEnvironment` answers a different
 * question — so this goes through drizzle directly. It throws rather than
 * defaulting when the aggregate returns nothing, so a broken query can never
 * read as "zero merchants persisted", which is the fact both callers assert.
 */
async function countMerchants(oxyAppId: string): Promise<number> {
  const [row] = await gatewayDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(merchants)
    .where(eq(merchants.oxyAppId, oxyAppId));
  if (!row) throw new Error('count(*) returned no row');
  return row.n;
}

useGatewayDatabase();

afterEach(async () => {
  await resetGatewayTables();
});

function createApp(
  appId: string,
  environment: string,
  files: FakeOxyFiles = createFakeOxyFiles([
    { id: 'file_mercaria_logo', ownerApplicationId: appId },
  ]),
  requireMerchant: RequestHandler = stubRequireMerchant(appId, environment),
): { app: ReturnType<typeof express>; requireMerchant: RequestHandler; files: FakeOxyFiles } {
  const app = express();
  app.use(express.json());
  app.use(createMerchantsRouter({ requireMerchant, files }));
  return { app, requireMerchant, files };
}

async function listen(
  app: ReturnType<typeof express>,
): Promise<{ server: Server; baseUrl: string }> {
  const s = app.listen(0);
  await new Promise<void>((resolve) => s.once('listening', resolve));
  const address = s.address() as AddressInfo;
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('POST /v1/merchants', () => {
  test('a production credential registers a mainnet merchant (201)', async () => {
    const { app } = createApp(PROD_APP_ID, 'production');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.id).toMatch(/^merch_[0-9a-f]{24}$/);
      expect(body.object).toBe('merchant');
      expect(body.environment).toBe('production');
      expect(body.network).toBe('mainnet');
      expect(body.required_confirmations).toBe(1);
    } finally {
      s.close();
    }
  });

  test('a development credential cannot NAME a network: it is always testnet (400) — test/live firewall', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network: 'mainnet' }),
      });
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error?.type).toBe('invalid_request_error');
      const count = await countMerchants(DEV_APP_ID);
      expect(count).toBe(0);
    } finally {
      s.close();
    }
  });

  test('a development credential registers a testnet merchant (201)', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.environment).toBe('development');
      expect(body.network).toBe('testnet');
    } finally {
      s.close();
    }
  });

  test('a merchant never registers a key of any kind (ADR 0021 D5): an xpub is refused (400)', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xpub: 'tpub-anything' }),
      });
      expect(res.status).toBe(400);
      const count = await countMerchants(DEV_APP_ID);
      expect(count).toBe(0);
    } finally {
      s.close();
    }
  });

  test('registering twice for the same app+environment collides (409)', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const first = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(first.status).toBe(201);

      const second = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(second.status).toBe(409);
    } finally {
      s.close();
    }
  });

  test('no service app credentials at all -> 401', async () => {
    const app = express();
    app.use(express.json());
    app.use(createMerchantsRouter({ requireMerchant: (_req, _res, next) => next() }));
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    } finally {
      s.close();
    }
  });

  test('a credential without payments:write is rejected (403 INSUFFICIENT_SCOPE)', async () => {
    const noScopeRequireMerchant: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: DEV_APP_ID,
        appName: 't',
        scopes: [],
        credentialId: 'c',
        ownerAccountId: 'owner',
        environment: 'development',
        tier: 'external',
      };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(createMerchantsRouter({ requireMerchant: noScopeRequireMerchant }));
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    } finally {
      s.close();
    }
  });
});

describe('GET /v1/merchants/me', () => {
  test("returns the caller's own merchant", async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const create = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const created = await readJson(create);

      const res = await fetch(`${url}/v1/merchants/me`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.id).toBe(created.id);
    } finally {
      s.close();
    }
  });

  test('no merchant registered for this app+environment yet -> 403', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants/me`);
      expect(res.status).toBe(403);
    } finally {
      s.close();
    }
  });

  test('no service app credentials at all -> 401', async () => {
    const app = express();
    app.use(express.json());
    app.use(createMerchantsRouter({ requireMerchant: (_req, _res, next) => next() }));
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants/me`);
      expect(res.status).toBe(401);
    } finally {
      s.close();
    }
  });
});

describe('PATCH /v1/merchants/me', () => {
  test('updates display_name and required_confirmations, and refuses webhook_url', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await fetch(`${url}/v1/merchants/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: 'New Name',
          required_confirmations: 3,
        }),
      });
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.display_name).toBe('New Name');
      expect(body.required_confirmations).toBe(3);
      // xpub/network/environment are immutable via this route.
      expect(body.network).toBe('testnet');
      expect('webhook_url' in body).toBe(false);

      // Where events go is the webhook_endpoint resource now (ADR 0014 D4).
      const refused = await fetch(`${url}/v1/merchants/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: 'https://merchant.example/hook' }),
      });
      expect(refused.status).toBe(400);
    } finally {
      s.close();
    }
  });

  test('xpub is not a field this route accepts — an attempted xpub change is refused and changes nothing', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await fetch(`${url}/v1/merchants/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required_confirmations: 2, xpub: 'attempted-change' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as unknown).toMatchObject({
        error: { type: 'invalid_request_error', param: 'xpub' },
      });
      const after = await readJson(await fetch(`${url}/v1/merchants/me`));
      expect('xpub' in after).toBe(false);
      expect(after.required_confirmations).toBe(1);
    } finally {
      s.close();
    }
  });

  test('no service app credentials at all -> 401', async () => {
    const app = express();
    app.use(express.json());
    app.use(createMerchantsRouter({ requireMerchant: (_req, _res, next) => next() }));
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required_confirmations: 2 }),
      });
      expect(res.status).toBe(401);
    } finally {
      s.close();
    }
  });
});

describe('merchant branding', () => {
  // Before these fields had a write path, `merchants.display_name`,
  // `avatar_file_id` and `description` were read by `resolveMerchantDisplay`
  // and `enrichAddresses` but written by nothing, so EVERY merchant rendered
  // to a payer as the "Peable merchant" fallback with no logo.
  test('registration persists the branding fields and returns them', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: 'Mercaria',
          avatar_file_id: 'file_mercaria_logo',
          description: 'Fair goods, fairly paid for.',
        }),
      });
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.display_name).toBe('Mercaria');
      expect(body.avatar_file_id).toBe('file_mercaria_logo');
      expect(body.description).toBe('Fair goods, fairly paid for.');
    } finally {
      s.close();
    }
  });

  test("the payer-facing display resolves to the merchant's own name", async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: 'Mercaria',
        }),
      });

      const row = await findMerchantByAppEnvironment(gatewayDb(), DEV_APP_ID, 'development');
      if (!row) throw new Error('merchant was not registered');
      const display = await resolveMerchantDisplay(row);

      // This string is what the hosted checkout page shows the payer.
      expect(display.name).toBe('Mercaria');
    } finally {
      s.close();
    }
  });

  test('PATCH updates branding, and an explicit null clears it', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: 'Old' }),
      });

      const patched = await fetch(`${url}/v1/merchants/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: 'New', description: null }),
      });
      expect(patched.status).toBe(200);
      const body = await readJson(patched);
      expect(body.display_name).toBe('New');
      expect(body.description).toBeUndefined();
    } finally {
      s.close();
    }
  });

  test('an absent branding field leaves the stored value alone', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: 'Kept' }),
      });

      // Patching an unrelated field must not blank the name — `null` clears,
      // absent means "leave alone", as every nullable field.
      const patched = await fetch(`${url}/v1/merchants/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required_confirmations: 3 }),
      });
      const body = await readJson(patched);
      expect(body.display_name).toBe('Kept');
      expect(body.required_confirmations).toBe(3);
    } finally {
      s.close();
    }
  });

  test('an over-long display_name is refused (400)', async () => {
    const { app } = createApp(DEV_APP_ID, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      // The columns are bare `text()` with no CHECK, so the route schema is the
      // only thing standing between a merchant and an unbounded write.
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: 'x'.repeat(200),
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      s.close();
    }
  });
});

/**
 * Registering takes no FairCoin key (ADR 0021 D5): every merchant's FairCoin
 * goes to the Peable wallet of the account that owns its application, on its
 * environment's network.
 */
describe('keyless registration', () => {
  test("registers with no key: the environment's network, the credential's owner (201)", async () => {
    const { app } = createApp(`${DEV_APP_ID}_keyless`, 'development');
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: 'Cards And FairCoin Ltd' }),
      });
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.network).toBe('testnet');
      expect('xpub' in body).toBe(false);
      expect(body.display_name).toBe('Cards And FairCoin Ltd');
    } finally {
      s.close();
    }
  });
});

describe('merchant avatar ownership (ADR 0043)', () => {
  /** A service token of DEV_APP_ID, owned by account `owner`, optionally acting as a user. */
  function stubWithActingAs(userId: string | undefined): RequestHandler {
    const base = stubRequireMerchant(DEV_APP_ID, 'development');
    return (req, res, next) =>
      base(req, res, () => {
        if (userId)
          (req as OxyAuthRequest).serviceActingAs = {
            userId,
            scopes: ['payments:read', 'payments:write'],
          };
        next();
      });
  }

  async function register(
    files: FakeOxyFiles,
    avatarFileId: string,
    requireMerchant?: RequestHandler,
  ): Promise<{ status: number; body: MerchantResponse }> {
    const { app } = createApp(DEV_APP_ID, 'development', files, requireMerchant);
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_file_id: avatarFileId }),
      });
      return { status: res.status, body: await readJson(res) };
    } finally {
      s.close();
    }
  }

  async function queuedSyncs(): Promise<string[]> {
    const rows = await gatewayDb().select().from(oxyFileReferenceSyncs);
    return rows.map((row) => referenceKey(row)).sort();
  }

  test("accepts the merchant application's own file, references it, and queues its sync in the same write", async () => {
    const files = createFakeOxyFiles([{ id: 'file_app', ownerApplicationId: DEV_APP_ID }]);
    const { status, body } = await register(files, 'file_app');
    expect(status).toBe(201);
    expect(body.avatar_file_id).toBe('file_app');
    expect([...files.held]).toEqual([`file_app|merchant_avatar|${body.id}`]);
    expect(await queuedSyncs()).toEqual([`file_app|merchant_avatar|${body.id}`]);
  });

  test("accepts a file owned by the application's owner account", async () => {
    // `stubRequireMerchant` signs the token's owner account as `owner`.
    const files = createFakeOxyFiles([{ id: 'file_owner', ownerUserId: 'owner' }]);
    expect((await register(files, 'file_owner')).status).toBe(201);
  });

  test('accepts a file of the user a delegated token acts as', async () => {
    const files = createFakeOxyFiles([{ id: 'file_user', ownerUserId: 'user_delegator' }]);
    expect((await register(files, 'file_user', stubWithActingAs('user_delegator'))).status).toBe(
      201,
    );
  });

  test("refuses ANYONE ELSE'S file — another account's, another application's — and references nothing", async () => {
    const files = createFakeOxyFiles([
      { id: 'file_stranger', ownerUserId: 'user_stranger' },
      { id: 'file_other_app', ownerApplicationId: 'app_somebody_else' },
      { id: 'file_platform', ownerUserId: null },
    ]);
    for (const fileId of ['file_stranger', 'file_other_app', 'file_platform', 'file_missing']) {
      const { status, body } = await register(files, fileId);
      expect(status).toBe(400);
      expect(body.error?.type).toBe('invalid_request_error');
    }
    expect(files.added).toEqual([]);
    expect(await countMerchants(DEV_APP_ID)).toBe(0);
  });

  test('refuses a file in trash, even its own', async () => {
    const files = createFakeOxyFiles([
      { id: 'file_trashed', ownerApplicationId: DEV_APP_ID, status: 'trash' },
    ]);
    expect((await register(files, 'file_trashed')).status).toBe(400);
  });

  test('refuses a file Oxy will not let Peable reference (private): no payer could load it', async () => {
    const files = createFakeOxyFiles([
      { id: 'file_private', ownerApplicationId: DEV_APP_ID, referenceable: false },
    ]);
    const { status, body } = await register(files, 'file_private');
    expect(status).toBe(400);
    expect(body.error?.message).toContain('public or unlisted');
    expect(await countMerchants(DEV_APP_ID)).toBe(0);
  });

  test('FAILS CLOSED when Oxy hides the owner, or cannot be reached', async () => {
    const owned = [{ id: 'file_app', ownerApplicationId: DEV_APP_ID }];
    for (const options of [{ hideOwner: true }, { failMetadata: true }, { failReferences: true }]) {
      const { status, body } = await register(createFakeOxyFiles(owned, options), 'file_app');
      expect(status).toBe(503);
      expect(body.error?.type).toBe('api_error');
    }
    expect(await countMerchants(DEV_APP_ID)).toBe(0);
  });

  test('a registration refused AFTER the reference was taken queues its release', async () => {
    const files = createFakeOxyFiles([{ id: 'file_app', ownerApplicationId: DEV_APP_ID }]);
    const first = await register(files, 'file_app');
    expect(first.status).toBe(201);
    // A second registration for the same app+environment is refused with 409
    // only AFTER its avatar was accepted and referenced under a new public id.
    const second = await register(files, 'file_app');
    expect(second.status).toBe(409);
    const entities = (await queuedSyncs()).map((key) => key.split('|')[2]);
    expect(entities).toHaveLength(2);
    expect(entities).toContain(first.body.id);
    // The other names no merchant: the sync finds it unwanted and removes it.
    const orphan = entities.find((id) => id !== first.body.id);
    expect(orphan).toMatch(/^merch_/);
    expect(files.held.has(`file_app|merchant_avatar|${orphan}`)).toBe(true);
  });

  test('PATCH to a new avatar checks it, and queues BOTH the old and the new reference', async () => {
    const files = createFakeOxyFiles([
      { id: 'file_a', ownerApplicationId: DEV_APP_ID },
      { id: 'file_b', ownerUserId: 'owner' },
      { id: 'file_stranger', ownerUserId: 'user_stranger' },
    ]);
    const { app } = createApp(DEV_APP_ID, 'development', files);
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const created = await fetch(`${url}/v1/merchants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_file_id: 'file_a' }),
      });
      const merchant = await readJson(created);
      await gatewayDb().delete(oxyFileReferenceSyncs);

      const refused = await fetch(`${url}/v1/merchants/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_file_id: 'file_stranger' }),
      });
      expect(refused.status).toBe(400);
      expect(await queuedSyncs()).toEqual([]);

      const patched = await fetch(`${url}/v1/merchants/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_file_id: 'file_b' }),
      });
      expect(patched.status).toBe(200);
      expect((await readJson(patched)).avatar_file_id).toBe('file_b');
      expect(await queuedSyncs()).toEqual([
        `file_a|merchant_avatar|${merchant.id}`,
        `file_b|merchant_avatar|${merchant.id}`,
      ]);

      // Clearing needs nothing from Oxy and queues the release.
      const lookupsBefore = files.added.length;
      await gatewayDb().delete(oxyFileReferenceSyncs);
      const cleared = await fetch(`${url}/v1/merchants/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_file_id: null }),
      });
      expect(cleared.status).toBe(200);
      expect(files.added.length).toBe(lookupsBefore);
      expect(await queuedSyncs()).toEqual([`file_b|merchant_avatar|${merchant.id}`]);
    } finally {
      s.close();
    }
  });
});
