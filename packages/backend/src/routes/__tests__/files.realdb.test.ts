/**
 * Files (`file_…`) over Oxy Files, end to end over HTTP against a real
 * database and a fake Oxy Files.
 *
 *  - an upload is checked against its purpose by its BYTES, stored as Peable's
 *    own application file (private, or public for a logo) with its `file`
 *    reference, and its reference sync is queued in the row's transaction;
 *  - an import (`oxy_file`) passes the ONE ownership check, and only a logo
 *    can be imported;
 *  - a retry under the same Idempotency-Key replays; the same key with other
 *    bytes is refused;
 *  - Oxy's file events withhold and remove Files, and a removed File's
 *    reference is released;
 *  - the merchant's `business_logo` names one of their own logo Files and
 *    reaches payers as `logo_url`, beside the avatar.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { and, eq } from 'drizzle-orm';
import express from 'express';
import type { RequestHandler } from 'express';
import type { FileEvent, OxyAuthRequest } from '@oxy.so/core/server';
import { createFilesRouter } from '../files';
import { createMerchantsRouter } from '../merchants';
import { createFakeOxyFiles, referenceKey } from '../../__tests__/helpers/fakeOxyFiles';
import {
  gatewayDb,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { oxyFileReferenceSyncs } from '../../db/schema';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { findFileByPublicId } from '../../db/files/fileRepository';
import { applyFileEvent } from '../../services/oxyFiles/fileEvents';
import { resolveMerchantDisplay } from '../../services/merchantDisplay';
import { runReferenceReconciliation } from '../../services/oxyFiles/referenceReconciliation';
import { must } from '../../__tests__/helpers/must';
import { POSTGRES_TESTS_ENABLED } from '../../db/testDatabase';

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
type Json = Record<string, unknown> & {
  error?: { type: string; code?: string; param?: string; message: string };
};

const PDF = new TextEncoder().encode('%PDF-1.4\nshipping label\n%%EOF');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const TEXT = new TextEncoder().encode('just some words, not a document');

const OWNER_ACCOUNT = 'acct_owner_files';
const files = createFakeOxyFiles([
  { id: 'oxy_logo_owned', ownerUserId: OWNER_ACCOUNT },
  { id: 'oxy_logo_strangers', ownerUserId: 'someone_else' },
]);

let merchant: Merchant;
let other: Merchant;
let actingAs: () => Merchant;
let server: Server;
let baseUrl = '';

async function upload(
  purpose: string,
  bytes: Uint8Array,
  name = 'file.bin',
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json }> {
  const form = new FormData();
  form.set('purpose', purpose);
  form.set('file', new Blob([bytes]), name);
  const response = await fetch(`${baseUrl}/v1/files`, { method: 'POST', body: form, headers });
  return { status: response.status, json: (await response.json()) as Json };
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

function event(type: FileEvent['type'], fileId: string, file: Partial<FileEvent['file']> = {}) {
  return {
    id: `evt_${type}_${fileId}_${Date.now()}_${Math.random()}`,
    type,
    occurredAt: new Date(Date.now() + 1000).toISOString(),
    file: {
      id: fileId,
      ownerKind: 'application',
      visibility: 'private',
      status: 'active',
      ...file,
    },
    references: [],
  } as unknown as FileEvent;
}

async function syncQueued(oxyFileId: string, publicId: string): Promise<boolean> {
  const rows = await gatewayDb()
    .select({ fileId: oxyFileReferenceSyncs.fileId })
    .from(oxyFileReferenceSyncs)
    .where(
      and(
        eq(oxyFileReferenceSyncs.fileId, oxyFileId),
        eq(oxyFileReferenceSyncs.entityType, 'file'),
        eq(oxyFileReferenceSyncs.entityId, publicId),
      ),
    );
  return rows.length === 1;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('Files over Oxy Files', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    merchant = await seedMerchant();
    other = await seedMerchant();
    actingAs = () => merchant;
    const stubAuth: RequestHandler = (req, _res, next) => {
      const as = actingAs();
      (req as OxyAuthRequest).serviceApp = {
        appId: as.oxyAppId,
        appName: 't',
        scopes: ['payments:read', 'payments:write'],
        credentialId: 'c',
        ownerAccountId: OWNER_ACCOUNT,
        environment: 'development',
        tier: 'external',
      };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(createFilesRouter({ requireMerchant: stubAuth, files }));
    app.use(createMerchantsRouter({ requireMerchant: stubAuth, files }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    actingAs = () => merchant;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('an evidence upload is a private Peable file with its reference, queued in its transaction', async () => {
    const { status, json } = await upload('dispute_evidence', PDF, 'label.pdf');
    expect(status).toBe(200);
    expect(json).toMatchObject({
      object: 'file',
      livemode: false,
      purpose: 'dispute_evidence',
      filename: 'label.pdf',
      size: PDF.byteLength,
      type: 'pdf',
      status: 'available',
      url: null,
    });
    const row = must(await findFileByPublicId(gatewayDb(), merchant.id, String(json.id)));
    expect(files.stored.get(row.oxyFileId)?.visibility).toBe('private');
    expect(
      files.held.has(
        referenceKey({ fileId: row.oxyFileId, entityType: 'file', entityId: row.publicId }),
      ),
    ).toBe(true);
    expect(await syncQueued(row.oxyFileId, row.publicId)).toBe(true);
  });

  test('a logo is public and has a URL', async () => {
    const { status, json } = await upload('business_logo', PNG, 'logo.png');
    expect(status).toBe(200);
    expect(json.type).toBe('png');
    expect(typeof json.url).toBe('string');
    const row = must(await findFileByPublicId(gatewayDb(), merchant.id, String(json.id)));
    expect(files.stored.get(row.oxyFileId)?.visibility).toBe('public');
  });

  test('the type is read from the bytes, and each purpose keeps its own policy', async () => {
    const text = await upload('dispute_evidence', TEXT, 'evidence.pdf');
    expect(text.status).toBe(400);
    expect(text.json.error?.param).toBe('file');
    const pdfLogo = await upload('business_logo', PDF, 'logo.pdf');
    expect(pdfLogo.status).toBe(400);
    const big = new Uint8Array(600 * 1024);
    big.set(JPG);
    const bigLogo = await upload('business_logo', big, 'logo.jpg');
    expect(bigLogo.status).toBe(400);
    expect(bigLogo.json.error?.message).toContain('at most');
    const huge = new Uint8Array(11 * 1024 * 1024);
    huge.set(PNG);
    const tooLarge = await upload('identity_document', huge, 'id.png');
    expect(tooLarge.status).toBe(413);
    const badPurpose = await upload('selfie', PNG, 'x.png');
    expect(badPurpose.status).toBe(400);
    expect(badPurpose.json.error?.param).toBe('purpose');
  });

  test('the same Idempotency-Key replays the same file and refuses other bytes', async () => {
    const headers = { 'Idempotency-Key': `upload-${Date.now()}` };
    const first = await upload('additional_verification', PDF, 'a.pdf', headers);
    const replay = await upload('additional_verification', PDF, 'a.pdf', headers);
    expect(first.status).toBe(200);
    expect(replay.json.id).toBe(first.json.id);
    const changed = await upload('additional_verification', JPG, 'a.jpg', headers);
    expect(changed.status).toBe(400);
    expect(changed.json.error?.code).toBe('idempotency_error');
  });

  test('an import passes the one ownership check, and only a logo can be imported', async () => {
    const owned = await call('POST', '/v1/files', {
      purpose: 'business_logo',
      oxy_file: 'oxy_logo_owned',
    });
    expect(owned.status).toBe(200);
    expect(owned.json.purpose).toBe('business_logo');
    const strangers = await call('POST', '/v1/files', {
      purpose: 'business_logo',
      oxy_file: 'oxy_logo_strangers',
    });
    expect(strangers.status).toBe(400);
    expect(strangers.json.error?.param).toBe('oxy_file');
    const evidence = await call('POST', '/v1/files', {
      purpose: 'dispute_evidence',
      oxy_file: 'oxy_logo_owned',
    });
    expect(evidence.status).toBe(400);
    expect(evidence.json.error?.param).toBe('purpose');
  });

  test('lists by purpose, and never another merchant’s file', async () => {
    const mine = await upload('identity_document', JPG, 'id.jpg');
    const list = await call('GET', '/v1/files?purpose=identity_document');
    const ids = (list.json.data as { id: string; purpose: string }[]).map((file) => file.id);
    expect(ids).toContain(String(mine.json.id));
    expect(
      (list.json.data as { purpose: string }[]).every(
        (file) => file.purpose === 'identity_document',
      ),
    ).toBe(true);
    actingAs = () => other;
    expect((await call('GET', `/v1/files/${String(mine.json.id)}`)).status).toBe(404);
  });

  test('file events withhold and remove Files; a removed File releases its reference', async () => {
    const { json } = await upload('dispute_evidence', PDF, 'gone.pdf');
    const row = must(await findFileByPublicId(gatewayDb(), merchant.id, String(json.id)));

    await applyFileEvent(event('file.trashed', row.oxyFileId, { status: 'trash' }));
    expect((await call('GET', `/v1/files/${row.publicId}`)).json.status).toBe('withheld');

    await applyFileEvent(event('file.blocked', row.oxyFileId, { status: 'blocked' as never }));
    const removed = await call('GET', `/v1/files/${row.publicId}`);
    expect(removed.json.status).toBe('removed');
    expect(await syncQueued(row.oxyFileId, row.publicId)).toBe(true);

    // The nightly inventory no longer names it.
    const results = await runReferenceReconciliation({ files, dryRun: true, force: true });
    expect(results.find((result) => result.entityType === 'file')?.outcome).toBe('succeeded');
    const inventory = files.reconciliations.at(-1);
    expect(inventory?.entityType).toBe('file');
    expect(inventory?.items.some((item) => item.entityId === row.publicId)).toBe(false);
  });

  test('business_logo names one of the merchant’s own logo Files and reaches payers', async () => {
    const logo = await upload('business_logo', PNG, 'wordmark.png');
    const evidence = await upload('dispute_evidence', PDF, 'not-a-logo.pdf');

    const wrongPurpose = await call('POST', '/v1/merchants/me', {
      business_logo: evidence.json.id,
    });
    expect(wrongPurpose.status).toBe(400);

    const set = await call('POST', '/v1/merchants/me', { business_logo: logo.json.id });
    expect(set.status).toBe(200);
    expect(set.json.business_logo).toBe(logo.json.id);
    const display = await resolveMerchantDisplay(
      must(await findMerchantById(gatewayDb(), merchant.id)),
    );
    expect(display.logo_url).not.toBeNull();

    actingAs = () => other;
    const theirs = await call('POST', '/v1/merchants/me', { business_logo: logo.json.id });
    expect(theirs.status).toBe(400);
    actingAs = () => merchant;

    const cleared = await call('POST', '/v1/merchants/me', { business_logo: null });
    expect(cleared.json.business_logo).toBeUndefined();
  });
});
