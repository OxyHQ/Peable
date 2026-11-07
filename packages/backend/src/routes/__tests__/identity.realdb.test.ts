/**
 * Identity verification (ADR 0023) — over HTTP, against a real database, with
 * one recording fake provider PER MODE behind the registry.
 *
 * What is pinned: the lifecycle (create at the provider first, retrieve with
 * the person's credentials, cancel, update), the drain mapping every
 * `identity.verification_session.*` event through ONE compare-and-swap path
 * with its Orbit event, reports stored as outcomes only, redaction erasing the
 * merchant's reference from the row and its stored events, mode isolation (a
 * test session is never served by the live key and vice versa, a key-less mode
 * or an account without Identity is 503 `identity_unavailable`), and that no
 * column holds the person's data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import {
  IDENTITY_UNAVAILABLE_CODE,
  ProviderError,
  type ProviderMode,
  type ProviderVerificationReport,
  type ProviderVerificationSession,
} from '../../services/providers/provider';

/** A person's data the fake provider holds — and that must never reach Orbit's tables. */
const PERSON = {
  firstName: 'Jenny',
  lastName: 'Rosenthal-Identity',
  idNumber: '123-45-6789',
} as const;

const providerCalls: string[] = [];
const providerRequests: unknown[] = [];
let counter = 0;
const next = () => String(++counter);
/** The provider's sessions, keyed by provider id — what `getVerificationSession` answers. */
const sessions = new Map<string, ProviderVerificationSession>();
let identityEnabled = true;

function unavailable(): ProviderError {
  return new ProviderError({
    provider: 'stripe',
    stage: 'identity',
    message: 'identity verification is not enabled on the provider account',
    retryable: false,
    code: IDENTITY_UNAVAILABLE_CODE,
  });
}

function fakeProviderFor(mode: ProviderMode) {
  const record = (fn: string) => providerCalls.push(`${mode}:${fn}`);
  const notUsed = async () => {
    throw new Error('not used');
  };
  const read = (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error(`no session ${id}`);
    return session;
  };
  return {
    id: 'stripe' as const,
    createPayment: notUsed,
    confirm: notUsed,
    capture: notUsed,
    cancel: notUsed,
    refund: notUsed,
    getStatus: notUsed,
    verifyEvent: notUsed,
    createVerificationSession: async (request: {
      type: 'document' | 'id_number';
      idempotencyKey: string;
    }) => {
      record('createVerificationSession');
      providerRequests.push(request);
      if (!identityEnabled) throw unavailable();
      const session: ProviderVerificationSession = {
        providerObjectId: `vs_${mode}_${next()}`,
        status: 'requires_input',
        type: request.type,
        lastError: null,
        clientSecret: `vs_secret_${mode}`,
        url: `https://verify.example/${mode}`,
        lastReport: null,
        redaction: null,
      };
      sessions.set(session.providerObjectId, session);
      return session;
    },
    getVerificationSession: async (id: string) => {
      record('getVerificationSession');
      return read(id);
    },
    updateVerificationSession: async (request: {
      providerObjectId: string;
      type?: 'document' | 'id_number';
    }) => {
      record('updateVerificationSession');
      providerRequests.push(request);
      const updated = {
        ...read(request.providerObjectId),
        ...(request.type ? { type: request.type } : {}),
      };
      sessions.set(request.providerObjectId, updated);
      return updated;
    },
    cancelVerificationSession: async (request: { providerObjectId: string }) => {
      record('cancelVerificationSession');
      const canceled = {
        ...read(request.providerObjectId),
        status: 'canceled' as const,
        clientSecret: null,
        url: null,
      };
      sessions.set(request.providerObjectId, canceled);
      return canceled;
    },
    redactVerificationSession: async (request: { providerObjectId: string }) => {
      record('redactVerificationSession');
      const current = read(request.providerObjectId);
      const redacted = {
        ...current,
        status: current.status === 'requires_input' ? ('canceled' as const) : current.status,
        redaction: 'processing' as const,
        clientSecret: null,
        url: null,
      };
      sessions.set(request.providerObjectId, redacted);
      return redacted;
    },
    getVerifiedOutputs: async (id: string, include: { dob: boolean; idNumber: boolean }) => {
      record('getVerifiedOutputs');
      read(id);
      return {
        firstName: PERSON.firstName,
        lastName: PERSON.lastName,
        address: null,
        email: null,
        phone: null,
        idNumberType: 'us_ssn' as const,
        ...(include.dob ? { dob: { day: 1, month: 2, year: 1990 } } : {}),
        ...(include.idNumber ? { idNumber: PERSON.idNumber } : {}),
      };
    },
  };
}

const fakes = { test: fakeProviderFor('test'), live: fakeProviderFor('live') };

const realRegistry = await import('../../services/providers/registry');
const { resolveProvider: realResolveProvider } = realRegistry;
let useFakeRegistry = false;
const { config } = await import('../../config');
function fakeFor(mode: ProviderMode) {
  return config.stripe[mode]?.cardRail ? fakes[mode] : undefined;
}
mock.module('../../services/providers/registry', () => ({
  ...realRegistry,
  resolveProvider: (id: 'stripe', mode: ProviderMode) =>
    useFakeRegistry ? fakeFor(mode) : realResolveProvider(id, mode),
}));

const { setStripeModes, stripeModeFixture } = await import('../../__tests__/helpers/stripeModes');
const { createIdentityRouter, mountIdentityDashboardRoutes } = await import('../identity');
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { insertProviderEvent, findProviderEventById } = await import(
  '../../db/providers/providerEventRepository'
);
const { processProviderEvent } = await import('../../services/providers/eventProcessor');
const { applyVerificationSnapshot } = await import('../../services/identity/verificationSessions');
const { findVerificationSessionForMerchant } = await import(
  '../../db/identity/verificationRepository'
);
const { events, verificationReports, verificationSessions } = await import('../../db/schema');
const { eq, sql } = await import('drizzle-orm');
const { wrap } = await import('../../lib/http');
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');
const { must } = await import('../../__tests__/helpers/must');

const APP_ID = 'app_identity';
const OTHER_APP_ID = 'app_identity_other';
let credential: { appId: string; environment: OxyServiceEnvironment } = {
  appId: APP_ID,
  environment: 'development',
};

const stubRequireMerchant: RequestHandler = (req, _res, nextHandler) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: credential.appId,
    appName: 't',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: credential.environment,
    tier: 'external',
  };
  nextHandler();
};

let server: Server;
let baseUrl = '';
let restoreModes: () => void = () => undefined;

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
type Json = any;

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Json,
  };
}

async function eventTypes(merchantId: string): Promise<string[]> {
  const rows = await gatewayDb()
    .select({ type: events.type })
    .from(events)
    .where(eq(events.merchantId, merchantId))
    .orderBy(events.createdAt, events.id);
  return rows.map((row) => row.type).filter((type) => type.startsWith('identity.'));
}

async function deliver(type: string, providerObjectId: string, livemode = false) {
  const n = next();
  const id = await insertProviderEvent(gatewayDb(), {
    provider: 'stripe',
    providerEventId: `evt_identity_${n}`,
    providerAccountId: null,
    type,
    livemode,
    apiVersion: '2026-07-29.dahlia',
    objectIds: { 'identity.verification_session': providerObjectId },
    payload: { id: `evt_identity_${n}`, object: 'event' },
  });
  const row = id ? await findProviderEventById(gatewayDb(), id) : null;
  if (!row) throw new Error('event not stored');
  return processProviderEvent(row);
}

/** Move the provider's session, as the person and the provider would. */
function providerSays(id: string, change: Partial<ProviderVerificationSession>): void {
  sessions.set(id, { ...must(sessions.get(id)), ...change });
}

async function providerIdOf(publicId: string, merchantId: string): Promise<string> {
  return must(await findVerificationSessionForMerchant(gatewayDb(), publicId, merchantId))
    .providerObjectId;
}

const REPORT: ProviderVerificationReport = {
  providerObjectId: 'vr_provider_1',
  type: 'document',
  document: { status: 'verified', errorCode: null },
  idNumber: null,
  selfie: { status: 'verified', errorCode: null },
};

describe.skipIf(!POSTGRES_TESTS_ENABLED)('identity verification', () => {
  useGatewayDatabase();

  let merchantId = '';
  let liveMerchantId = '';

  beforeAll(async () => {
    useFakeRegistry = true;
    restoreModes = setStripeModes({
      test: stripeModeFixture('test'),
      live: stripeModeFixture('live'),
    });
    const merchant = await seedMerchant({ oxyAppId: APP_ID, environment: 'development' });
    merchantId = merchant.id;
    const live = await seedMerchant({ oxyAppId: APP_ID, environment: 'production' });
    liveMerchantId = live.id;
    await seedMerchant({ oxyAppId: OTHER_APP_ID, environment: 'development' });

    const app = express();
    app.use(express.json());
    app.use(createIdentityRouter({ requireMerchant: stubRequireMerchant }));
    // Orbit's surface, behind a gate that admits the development merchant.
    const dashboard = express.Router();
    mountIdentityDashboardRoutes(dashboard, {
      base: '/v1/dashboard/applications/:applicationId',
      requireOxyUser: (_req, _res, nextHandler) => nextHandler(),
      gate: (_action, core) =>
        wrap(async (req, res) => {
          await core(req, res, merchant, {} as never);
        }),
    });
    app.use(dashboard);
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
        res.status(500).json({ error: { type: 'api_error', message: error.message } });
      },
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    providerRequests.length = 0;
    credential = { appId: APP_ID, environment: 'development' };
    identityEnabled = true;
  });

  afterAll(async () => {
    restoreModes();
    useFakeRegistry = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('create: at the provider first, the credentials answered once, the row keeps none of them', async () => {
    const created = await call('POST', '/v1/identity/verification_sessions', {
      type: 'document',
      options: { document: { allowed_types: ['passport'], require_matching_selfie: true } },
      return_url: 'https://merchant.example/done',
      client_reference_id: 'user_42',
      metadata: { order: 'o_1' },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(created.body).toMatchObject({
      object: 'identity.verification_session',
      livemode: false,
      type: 'document',
      status: 'requires_input',
      options: {
        document: {
          allowed_types: ['passport'],
          require_id_number: null,
          require_live_capture: null,
          require_matching_selfie: true,
        },
      },
      client_secret: 'vs_secret_test',
      url: 'https://verify.example/test',
      client_reference_id: 'user_42',
      metadata: { order: 'o_1' },
      last_error: null,
      last_verification_report: null,
      redaction: null,
    });
    expect(created.body.id).toMatch(/^vs_/);
    expect(providerCalls).toEqual(['test:createVerificationSession']);
    // Only Orbit's correlation id crosses: the provider is not told the reference or metadata.
    expect(JSON.stringify(providerRequests)).not.toContain('user_42');
    expect(JSON.stringify(providerRequests)).not.toContain('o_1');
    expect(await eventTypes(merchantId)).toContain('identity.verification_session.created');

    // The list and the stored event carry neither credential.
    const list = await call('GET', '/v1/identity/verification_sessions');
    expect(list.status).toBe(200);
    const listed = list.body.data.find((s: Json) => s.id === created.body.id);
    expect(listed).toMatchObject({ client_secret: null, url: null });
    const [stored] = await gatewayDb()
      .select({ data: events.dataObject })
      .from(events)
      .where(sql`${events.dataObject}->>'id' = ${created.body.id}`);
    expect(must(stored).data).toMatchObject({ client_secret: null, url: null });

    // A retrieve while `requires_input` reads them fresh.
    const retrieved = await call('GET', `/v1/identity/verification_sessions/${created.body.id}`);
    expect(retrieved.status).toBe(200);
    expect(retrieved.body).toMatchObject({
      client_secret: 'vs_secret_test',
      url: 'https://verify.example/test',
    });
  });

  test('create refuses document options on an ID number session, before the provider', async () => {
    const refused = await call('POST', '/v1/identity/verification_sessions', {
      type: 'id_number',
      options: { document: { require_live_capture: true } },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.param).toBe('options[document]');
    expect(providerCalls).toEqual([]);
  });

  test('an account without Identity is 503 identity_unavailable, and nothing is stored', async () => {
    identityEnabled = false;
    const before = await gatewayDb()
      .select({ id: verificationSessions.id })
      .from(verificationSessions);
    const refused = await call('POST', '/v1/identity/verification_sessions', { type: 'document' });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('identity_unavailable');
    const after = await gatewayDb()
      .select({ id: verificationSessions.id })
      .from(verificationSessions);
    expect(after.length).toBe(before.length);
  });

  test('mode isolation: production reaches only the live key; a key-less mode is 503 and never the other key', async () => {
    credential = { appId: APP_ID, environment: 'production' };
    const live = await call('POST', '/v1/identity/verification_sessions', { type: 'id_number' });
    expect(live.status).toBe(201);
    expect(live.body).toMatchObject({ livemode: true, options: { id_number: {} } });
    expect(providerCalls).toEqual(['live:createVerificationSession']);

    providerCalls.length = 0;
    const restore = setStripeModes({ test: stripeModeFixture('test') });
    try {
      const refused = await call('POST', '/v1/identity/verification_sessions', {
        type: 'document',
      });
      expect(refused.status).toBe(503);
      expect(refused.body.error.code).toBe('identity_unavailable');
      // The stored live session cannot be served by the test key either.
      const cancel = await call(
        'POST',
        `/v1/identity/verification_sessions/${live.body.id}/cancel`,
        {},
      );
      expect(cancel.status).toBe(503);
    } finally {
      restore();
    }
    expect(providerCalls).toEqual([]);

    // A live event naming a test session is refused by the drain.
    credential = { appId: APP_ID, environment: 'development' };
    const test_ = await call('POST', '/v1/identity/verification_sessions', { type: 'document' });
    const outcome = await deliver(
      'identity.verification_session.processing',
      await providerIdOf(test_.body.id, merchantId),
      true,
    );
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect((outcome as { error: string }).error).toContain('live event names a test object');

    // And another merchant cannot read either.
    credential = { appId: OTHER_APP_ID, environment: 'development' };
    expect((await call('GET', `/v1/identity/verification_sessions/${test_.body.id}`)).status).toBe(
      404,
    );
  });

  test('the drain: processing, a failed attempt, then verified with a report — one event each, outcomes only', async () => {
    const created = await call('POST', '/v1/identity/verification_sessions', {
      type: 'document',
      options: { document: { require_matching_selfie: true } },
    });
    const id = created.body.id as string;
    const providerId = await providerIdOf(id, merchantId);

    providerSays(providerId, { status: 'processing', clientSecret: null, url: null });
    expect(await deliver('identity.verification_session.processing', providerId)).toMatchObject({
      kind: 'applied',
      status: 'processing',
    });
    // A redelivery changes nothing and records nothing.
    expect(await deliver('identity.verification_session.processing', providerId)).toMatchObject({
      kind: 'noop',
    });

    providerSays(providerId, {
      status: 'requires_input',
      lastError: { errorCode: 'selfie_face_mismatch' },
      lastReport: {
        providerObjectId: 'vr_provider_failed',
        type: 'document',
        document: { status: 'verified', errorCode: null },
        idNumber: null,
        selfie: { status: 'unverified', errorCode: 'selfie_face_mismatch' },
      },
    });
    await deliver('identity.verification_session.requires_input', providerId);
    const failed = await call('GET', `/v1/identity/verification_sessions/${id}`);
    expect(failed.body.status).toBe('requires_input');
    expect(failed.body.last_error).toEqual({
      code: 'selfie_face_mismatch',
      reason: "The selfie did not match the document's photo.",
    });

    providerSays(providerId, {
      status: 'verified',
      lastError: null,
      lastReport: REPORT,
      clientSecret: null,
      url: null,
    });
    await deliver('identity.verification_session.verified', providerId);
    const verified = await call(
      'GET',
      `/v1/identity/verification_sessions/${id}?expand[]=last_verification_report`,
    );
    expect(verified.body).toMatchObject({
      status: 'verified',
      last_error: null,
      client_secret: null,
      url: null,
      last_verification_report: {
        object: 'identity.verification_report',
        verification_session: id,
        document: { status: 'verified', error: null },
        id_number: null,
        selfie: { status: 'verified', error: null },
      },
    });
    expect(verified.body.verified_outputs).toBeUndefined();

    const reports = await call(
      'GET',
      `/v1/identity/verification_reports?verification_session=${id}`,
    );
    expect(reports.body.data).toHaveLength(2);
    expect(reports.body.data[1].selfie).toEqual({
      status: 'unverified',
      error: {
        code: 'selfie_face_mismatch',
        reason: "The selfie did not match the document's photo.",
      },
    });
    const report = await call(
      'GET',
      `/v1/identity/verification_reports/${reports.body.data[0].id}?expand[]=verification_session`,
    );
    expect(report.body.verification_session.id).toBe(id);

    const types = (await eventTypes(merchantId)).filter(
      (t) => t !== 'identity.verification_session.created',
    );
    expect(types.slice(-3)).toEqual([
      'identity.verification_session.processing',
      'identity.verification_session.requires_input',
      'identity.verification_session.verified',
    ]);

    // A terminal session never moves back: the drain refuses, visibly.
    providerSays(providerId, { status: 'requires_input' });
    expect(await deliver('identity.verification_session.requires_input', providerId)).toMatchObject(
      {
        kind: 'failed',
      },
    );
  });

  test('compare-and-swap: a snapshot applied to a row that already moved records nothing', async () => {
    const created = await call('POST', '/v1/identity/verification_sessions', { type: 'id_number' });
    const stale = must(
      await findVerificationSessionForMerchant(gatewayDb(), created.body.id, merchantId),
    );
    const providerId = stale.providerObjectId;
    providerSays(providerId, { status: 'processing' });
    await deliver('identity.verification_session.processing', providerId);
    const before = await eventTypes(merchantId);
    // The stale read (still `requires_input`) loses the race and changes nothing.
    const outcome = await applyVerificationSnapshot(stale, must(sessions.get(providerId)));
    expect(outcome.kind).toBe('agreed');
    expect(await eventTypes(merchantId)).toEqual(before);
  });

  test('verified_outputs: read live with the merchant credential, never stored, never in Orbit', async () => {
    const created = await call('POST', '/v1/identity/verification_sessions', { type: 'document' });
    const id = created.body.id as string;
    const providerId = await providerIdOf(id, merchantId);

    // Not verified yet: nothing to read, and the provider is not asked for it.
    const early = await call(
      'GET',
      `/v1/identity/verification_sessions/${id}?expand[]=verified_outputs`,
    );
    expect(early.body.verified_outputs).toBeNull();
    expect(providerCalls).not.toContain('test:getVerifiedOutputs');

    providerSays(providerId, {
      status: 'verified',
      lastReport: { ...REPORT, providerObjectId: 'vr_provider_outputs' },
    });
    await deliver('identity.verification_session.verified', providerId);
    const read = await call(
      'GET',
      `/v1/identity/verification_sessions/${id}?expand[]=verified_outputs&expand[]=verified_outputs.id_number`,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(read.body.verified_outputs).toMatchObject({
      first_name: PERSON.firstName,
      last_name: PERSON.lastName,
      id_number: PERSON.idNumber,
      id_number_type: 'us_ssn',
    });
    expect(read.body.verified_outputs.dob).toBeUndefined();

    const dashboard = await call(
      'GET',
      `/v1/dashboard/applications/${APP_ID}/identity/verification_sessions/${id}?environment=development&expand[]=verified_outputs`,
    );
    expect(dashboard.status).toBe(400);
    expect(dashboard.body.error.param).toBe('expand');
    const dashboardPlain = await call(
      'GET',
      `/v1/dashboard/applications/${APP_ID}/identity/verification_sessions/${id}?environment=development`,
    );
    expect(dashboardPlain.status).toBe(200);
    expect(dashboardPlain.body.verified_outputs).toBeUndefined();
  });

  test('nothing about the person is stored: the columns are the verdict, and no row holds their data', async () => {
    const columns = async (table: string) =>
      (
        await gatewayDb().execute<{ column_name: string }>(
          sql`select column_name from information_schema.columns where table_name = ${table} order by column_name`,
        )
      ).map((row) => row.column_name);
    expect(await columns('verification_sessions')).toEqual(
      [
        'client_reference_id',
        'created_at',
        'has_last_error',
        'id',
        'last_error_code',
        'merchant_id',
        'metadata',
        'options',
        'provider',
        'provider_object_id',
        'public_id',
        'redaction_status',
        'return_url',
        'status',
        'type',
        'updated_at',
      ].sort(),
    );
    expect(await columns('verification_reports')).toEqual(
      [
        'created_at',
        'document_error_code',
        'document_status',
        'id',
        'id_number_error_code',
        'id_number_status',
        'merchant_id',
        'options',
        'provider',
        'provider_object_id',
        'public_id',
        'selfie_error_code',
        'selfie_status',
        'type',
        'verification_session_id',
      ].sort(),
    );
    const everything = JSON.stringify([
      await gatewayDb().select().from(verificationSessions),
      await gatewayDb().select().from(verificationReports),
      await gatewayDb().select({ data: events.dataObject }).from(events),
    ]);
    for (const value of [
      PERSON.firstName,
      PERSON.lastName,
      PERSON.idNumber,
      'vs_secret_',
      'verify.example',
    ]) {
      expect(everything).not.toContain(value);
    }
  });

  test('update: type and options at the provider, metadata here — only while requires_input', async () => {
    const created = await call('POST', '/v1/identity/verification_sessions', {
      type: 'document',
      metadata: { keep: 'k', drop: 'd' },
    });
    const id = created.body.id as string;
    providerCalls.length = 0;
    const metadataOnly = await call('POST', `/v1/identity/verification_sessions/${id}`, {
      metadata: { drop: '', added: 'a' },
    });
    expect(metadataOnly.status).toBe(200);
    expect(metadataOnly.body.metadata).toEqual({ keep: 'k', added: 'a' });
    expect(providerCalls).toEqual([]);

    const retyped = await call('POST', `/v1/identity/verification_sessions/${id}`, {
      type: 'document',
      options: { document: { require_live_capture: true } },
    });
    expect(retyped.status).toBe(200);
    expect(retyped.body.options.document.require_live_capture).toBe(true);
    expect(providerCalls).toEqual(['test:updateVerificationSession']);

    await call('POST', `/v1/identity/verification_sessions/${id}/cancel`, {});
    const refused = await call('POST', `/v1/identity/verification_sessions/${id}`, {
      metadata: { late: 'x' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('verification_session_unexpected_state');
  });

  test('cancel: once, with its event; a second cancel is 409; the POST is idempotent', async () => {
    const created = await call('POST', '/v1/identity/verification_sessions', { type: 'document' });
    const id = created.body.id as string;
    const key = { 'Idempotency-Key': `cancel-${id}` };
    const canceled = await call('POST', `/v1/identity/verification_sessions/${id}/cancel`, {}, key);
    expect(canceled.status).toBe(200);
    expect(canceled.body).toMatchObject({ status: 'canceled', client_secret: null, url: null });
    const replay = await call('POST', `/v1/identity/verification_sessions/${id}/cancel`, {}, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(providerCalls.filter((c) => c.endsWith('cancelVerificationSession'))).toHaveLength(1);
    const again = await call('POST', `/v1/identity/verification_sessions/${id}/cancel`, {});
    expect(again.status).toBe(409);
    expect(
      (await eventTypes(merchantId)).filter((t) => t.endsWith('.canceled')).length,
    ).toBeGreaterThan(0);
  });

  test('redact: the provider erases, Orbit erases the reference from the row and its events; refused while processing', async () => {
    const created = await call('POST', '/v1/identity/verification_sessions', {
      type: 'document',
      client_reference_id: 'person_to_forget',
      metadata: { email_hash: 'abc' },
    });
    const id = created.body.id as string;
    const providerId = await providerIdOf(id, merchantId);

    const redacted = await call('POST', `/v1/identity/verification_sessions/${id}/redact`, {});
    expect(redacted.status).toBe(200);
    expect(redacted.body).toMatchObject({
      status: 'canceled',
      redaction: { status: 'processing' },
      client_reference_id: null,
      metadata: {},
    });
    const snapshots = await gatewayDb()
      .select({ data: events.dataObject })
      .from(events)
      .where(sql`${events.dataObject}->>'id' = ${id}`);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(snapshots)).not.toContain('person_to_forget');
    expect(JSON.stringify(snapshots)).not.toContain('email_hash');

    // A second redaction answers as it stands; nothing else can change it.
    providerCalls.length = 0;
    expect((await call('POST', `/v1/identity/verification_sessions/${id}/redact`, {})).status).toBe(
      200,
    );
    expect(providerCalls).toEqual([]);

    // The provider finishes: `redacted`, told once.
    providerSays(providerId, { redaction: 'redacted' });
    await deliver('identity.verification_session.redacted', providerId);
    await deliver('identity.verification_session.redacted', providerId);
    const done = await call('GET', `/v1/identity/verification_sessions/${id}`);
    expect(done.body.redaction).toEqual({ status: 'redacted' });
    expect((await eventTypes(merchantId)).filter((t) => t.endsWith('.redacted'))).toHaveLength(1);

    // A session the provider is still checking cannot be redacted.
    const busy = await call('POST', '/v1/identity/verification_sessions', { type: 'document' });
    const busyProvider = await providerIdOf(busy.body.id, merchantId);
    providerSays(busyProvider, { status: 'processing' });
    await deliver('identity.verification_session.processing', busyProvider);
    const refused = await call(
      'POST',
      `/v1/identity/verification_sessions/${busy.body.id}/redact`,
      {},
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('verification_session_unexpected_state');
  });

  test('lists filter by status and reference; a production credential sees only live sessions', async () => {
    const byStatus = await call('GET', '/v1/identity/verification_sessions?status=verified');
    expect(byStatus.status).toBe(200);
    expect(byStatus.body.data.every((s: Json) => s.status === 'verified')).toBe(true);
    const byRef = await call(
      'GET',
      '/v1/identity/verification_sessions?client_reference_id=user_42',
    );
    expect(byRef.body.data.map((s: Json) => s.client_reference_id)).toEqual(['user_42']);
    credential = { appId: APP_ID, environment: 'production' };
    const live = await call('GET', '/v1/identity/verification_sessions');
    expect(live.body.data.length).toBeGreaterThan(0);
    expect(live.body.data.every((s: Json) => s.livemode === true)).toBe(true);
    const badRef = await call(
      'GET',
      '/v1/identity/verification_reports?verification_session=vs_nope',
    );
    expect(badRef.status).toBe(400);
    expect(liveMerchantId).not.toBe(merchantId);
  });
});
