/**
 * Oxy's file events, through the REAL middleware chain (`createGateway()`) over
 * a real socket and a real database.
 *
 * The chain is the point, as in `providerWebhooks.integration.test.ts`: the
 * signature covers the raw bytes, so this router must be mounted before
 * `express.json()`. A deliberately json-parsed copy of the same router is the
 * counterexample that shows the order is load-bearing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import express from 'express';
import { createGateway } from '../../server';
import { config, type OxyFilesConfig } from '../../config';
import { createOxyFileEventsRouter, OXY_FILE_EVENTS_PATH } from '../oxyFileEvents';
import {
  merchantAvatarAudit,
  merchants,
  oxyFileEvents,
  oxyFileReferenceSyncs,
} from '../../db/schema';
import { findMerchantById, updateMerchantSettings } from '../../db/merchants/merchantRepository';
import { resolveMerchantDisplay } from '../../services/merchantDisplay';
import {
  gatewayDb,
  resetGatewayTables,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { must } from '../../__tests__/helpers/must';
import { POSTGRES_TESTS_ENABLED } from '../../db/testDatabase';

const SECRET = 'whsec_file_events_test';
const PREVIOUS = 'whsec_file_events_previous';
const REAL_OXY_FILES: OxyFilesConfig = config.oxyFiles;

let gatewayServer: Server | undefined;
let parsedServer: Server | undefined;
let gatewayUrl = '';
let parsedUrl = '';

function sign(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${v1}`;
}

let eventCounter = 0;
function fileEvent(
  type: string,
  fileId: string,
  overrides: {
    status?: string;
    visibility?: string;
    occurredAt?: string;
    id?: string;
  } = {},
): string {
  eventCounter += 1;
  return JSON.stringify({
    id: overrides.id ?? `evt_file_${eventCounter}_${Date.now()}`,
    type,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    file: {
      id: fileId,
      ownerKind: 'account',
      visibility: overrides.visibility ?? 'public',
      status: overrides.status ?? 'active',
    },
    references: [{ entityType: 'merchant_avatar', entityId: 'merch_x' }],
  });
}

async function post(
  body: string,
  headers: Record<string, string> = {},
  base = gatewayUrl,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${OXY_FILE_EVENTS_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function auditFor(merchantId: string) {
  return gatewayDb()
    .select()
    .from(merchantAvatarAudit)
    .where(eq(merchantAvatarAudit.merchantId, merchantId));
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('Oxy file events, real chain', () => {
  useGatewayDatabase();

  beforeAll(() => {
    config.oxyFiles = { ...REAL_OXY_FILES, webhookSecret: SECRET, webhookSecretPrevious: PREVIOUS };
    const passthrough = (_req: unknown, _res: unknown, next: () => void) => {
      next();
    };
    const gateway = createGateway({
      requireMerchant: passthrough as never,
      optionalServiceAuth: passthrough as never,
      requireOxyUser: passthrough as never,
      publicRateLimit: passthrough as never,
    });
    gatewayServer = gateway.httpServer.listen(0);
    gatewayUrl = `http://127.0.0.1:${String((gatewayServer.address() as AddressInfo).port)}`;

    const parsedApp = express();
    parsedApp.use(express.json());
    parsedApp.use(createOxyFileEventsRouter());
    parsedServer = parsedApp.listen(0);
    parsedUrl = `http://127.0.0.1:${String((parsedServer.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    config.oxyFiles = REAL_OXY_FILES;
    for (const server of [gatewayServer, parsedServer]) {
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
    }
  });

  beforeEach(async () => {
    await resetGatewayTables();
  });

  test('answers the endpoint verification challenge by echoing it', async () => {
    const { status, json } = await post(
      JSON.stringify({ type: 'webhook.challenge', challenge: 'chal_123' }),
    );
    expect(status).toBe(200);
    expect(json).toEqual({ challenge: 'chal_123' });
  });

  test('refuses a forged or stale signature, and stores nothing', async () => {
    const body = fileEvent('file.deleted', 'file_forged');
    expect((await post(body, { 'oxy-signature': sign(body, 'whsec_wrong') })).status).toBe(400);
    expect((await post(body)).status).toBe(400);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await post(body, { 'oxy-signature': sign(body, SECRET, stale) })).status).toBe(400);
    expect(await gatewayDb().select().from(oxyFileEvents)).toEqual([]);
  });

  test('THE ORDER: the same signed body verifies through createGateway and fails behind express.json()', async () => {
    const body = fileEvent('file.visibility_changed', 'file_order');
    expect((await post(body, { 'oxy-signature': sign(body) })).status).toBe(200);
    const parsed = await post(body, { 'oxy-signature': sign(body) }, parsedUrl);
    expect(parsed.status).toBe(400);
  });

  for (const type of ['file.deleted', 'file.blocked', 'file.lost'] as const) {
    test(`${type} clears the avatar, audits it, queues the reference release — once`, async () => {
      const merchant = await seedMerchant({ avatarFileId: `file_${type}` });
      await gatewayDb().delete(oxyFileReferenceSyncs);
      const body = fileEvent(type, `file_${type}`, { status: 'deleted' });

      const first = await post(body, { 'oxy-signature': sign(body) });
      expect(first).toEqual({ status: 200, json: { received: true, duplicate: false } });
      const after = must(await findMerchantById(gatewayDb(), merchant.id));
      expect(after.avatarFileId).toBeNull();
      const audit = await auditFor(merchant.id);
      expect(audit.map((row) => [row.action, row.eventType, row.fileId])).toEqual([
        ['cleared', type, `file_${type}`],
      ]);
      const syncs = await gatewayDb().select().from(oxyFileReferenceSyncs);
      expect(syncs.map((row) => [row.fileId, row.entityId])).toEqual([
        [`file_${type}`, merchant.publicId],
      ]);

      // Redelivery: acknowledged, applied nothing.
      const again = await post(body, { 'oxy-signature': sign(body) });
      expect(again).toEqual({ status: 200, json: { received: true, duplicate: true } });
      expect(await auditFor(merchant.id)).toHaveLength(1);
    });
  }

  test('trash WITHHOLDS the avatar from payers, restore shows it again, and an older event loses', async () => {
    const merchant = await seedMerchant({ avatarFileId: 'file_trash_cycle' });
    const t1 = new Date(Date.now() + 1_000).toISOString();
    const t2 = new Date(Date.now() + 2_000).toISOString();

    const trashed = fileEvent('file.trashed', 'file_trash_cycle', {
      status: 'trash',
      occurredAt: t1,
    });
    expect((await post(trashed, { 'oxy-signature': sign(trashed) })).status).toBe(200);
    let row = must(await findMerchantById(gatewayDb(), merchant.id));
    expect(row.avatarFileId).toBe('file_trash_cycle');
    expect(row.avatarWithheld).toBe('unavailable');
    expect((await resolveMerchantDisplay(row)).avatarUrl).toBeNull();

    const restored = fileEvent('file.restored', 'file_trash_cycle', { occurredAt: t2 });
    expect((await post(restored, { 'oxy-signature': sign(restored) })).status).toBe(200);
    row = must(await findMerchantById(gatewayDb(), merchant.id));
    expect(row.avatarWithheld).toBeNull();
    expect((await resolveMerchantDisplay(row)).avatarUrl).toContain('file_trash_cycle');

    // A trash event that HAPPENED before the restore, delivered after it.
    const late = fileEvent('file.trashed', 'file_trash_cycle', {
      status: 'trash',
      occurredAt: new Date(Date.parse(t1) - 500).toISOString(),
    });
    expect((await post(late, { 'oxy-signature': sign(late) })).status).toBe(200);
    row = must(await findMerchantById(gatewayDb(), merchant.id));
    expect(row.avatarWithheld).toBeNull();

    expect((await auditFor(merchant.id)).map((entry) => entry.action).sort()).toEqual([
      'released',
      'withheld',
    ]);
  });

  test('an event from BEFORE the avatar was set is ignored', async () => {
    const merchant = await seedMerchant({ avatarFileId: 'file_set_later' });
    const before = fileEvent('file.trashed', 'file_set_later', {
      status: 'trash',
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect((await post(before, { 'oxy-signature': sign(before) })).status).toBe(200);
    expect(must(await findMerchantById(gatewayDb(), merchant.id)).avatarWithheld).toBeNull();
  });

  test('made private: withheld as private', async () => {
    const merchant = await seedMerchant({ avatarFileId: 'file_private' });
    const body = fileEvent('file.visibility_changed', 'file_private', {
      visibility: 'private',
      occurredAt: new Date(Date.now() + 1_000).toISOString(),
    });
    expect((await post(body, { 'oxy-signature': sign(body) })).status).toBe(200);
    expect(must(await findMerchantById(gatewayDb(), merchant.id)).avatarWithheld).toBe('private');
  });

  test('a new avatar starts unwithheld', async () => {
    const merchant = await seedMerchant({ avatarFileId: 'file_first' });
    await gatewayDb()
      .update(merchants)
      .set({ avatarWithheld: 'private' })
      .where(eq(merchants.id, merchant.id));
    const updated = must(
      await updateMerchantSettings(gatewayDb(), merchant.id, { avatarFileId: 'file_second' }),
    );
    expect(updated.avatarWithheld).toBeNull();
  });

  test('the rotation window: the previous secret is still accepted', async () => {
    const body = fileEvent('file.visibility_changed', 'file_rotation');
    expect((await post(body, { 'oxy-signature': sign(body, PREVIOUS) })).status).toBe(200);
  });

  test('with no secret configured: the challenge still works, events are refused with a retryable 503', async () => {
    config.oxyFiles = {
      ...REAL_OXY_FILES,
      webhookSecret: undefined,
      webhookSecretPrevious: undefined,
    };
    try {
      const challenge = await post(JSON.stringify({ type: 'webhook.challenge', challenge: 'c' }));
      expect(challenge).toEqual({ status: 200, json: { challenge: 'c' } });
      const body = fileEvent('file.deleted', 'file_unconfigured');
      expect((await post(body, { 'oxy-signature': sign(body) })).status).toBe(503);
    } finally {
      config.oxyFiles = {
        ...REAL_OXY_FILES,
        webhookSecret: SECRET,
        webhookSecretPrevious: PREVIOUS,
      };
    }
  });
});
