/**
 * Peable Tax business compliance (ADR 0020) over HTTP, against a real
 * Postgres: the merchant API through the real gateway (request id,
 * idempotency, routers, events) with only the Oxy credential stubbed, and
 * Orbit's dashboard surface behind a stubbed membership answer.
 *
 * Every fact here is synthetic: no real company, identifier or customer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import express, { type RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { createGateway, type Gateway } from '../../server';
import { requestIdMiddleware } from '../../lib/requestId';
import type { AppMembershipResult } from '../../services/appMembership';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { insertFile } from '../../db/files/fileRepository';
import { files, taxSettings, taxTransactions } from '../../db/schema';
import { newId } from '../../lib/ids';
import { commitTaxTransaction, createTaxService, TaxError } from '../../services/tax/taxService';
import { TaxProviderUnavailableError, type TaxProvider } from '../../services/tax/provider';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedMerchant,
  storedEvents,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { createDashboardTaxComplianceRouter } from '../taxCompliance';

type Json = Record<string, unknown>;

const APP_A = 'app_compliance_a';
const APP_B = 'app_compliance_b';
/** What oxy-api would answer for each (user, application). */
const MEMBERS: Record<string, Record<string, AppMembershipResult>> = {
  owner_a: {
    [APP_A]: { allowed: true, permissions: ['app:read', 'billing:read', 'billing:manage'] },
  },
  viewer_a: { [APP_A]: { allowed: true, permissions: ['app:read', 'billing:read'] } },
  developer_a: { [APP_A]: { allowed: true, permissions: ['app:read'] } },
  owner_b: {
    [APP_B]: { allowed: true, permissions: ['app:read', 'billing:read', 'billing:manage'] },
  },
};

let gateway: Gateway | undefined;
let apiUrl = '';
let dashboardServer: Server | undefined;
let dashboardUrl = '';
let merchantA: MerchantRow;
let merchantB: MerchantRow;
const tax = () => createTaxService({ db: gatewayDb() });

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: req.header('X-Test-App') ?? APP_A,
    appName: 'compliance',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: 'production',
    tier: 'external',
  };
  next();
};

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json; headers: Headers }> {
  const response = await fetch(`${apiUrl}/v1/tax${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  const json = (raw.startsWith('{') ? JSON.parse(raw) : {}) as Json;
  return { status: response.status, json, headers: response.headers };
}

async function dash(
  method: string,
  path: string,
  body?: unknown,
  opts: { user?: string; app?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Json; headers: Headers }> {
  const sep = path.includes('?') ? '&' : '?';
  const response = await fetch(
    `${dashboardUrl}/v1/dashboard/applications/${opts.app ?? APP_A}/tax${path}${sep}environment=production`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Test-User-Id': opts.user ?? 'owner_a',
        ...opts.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return {
    status: response.status,
    json: (await response.json()) as Json,
    headers: response.headers,
  };
}

/** A dashboard call that must succeed. */
async function owner(method: string, path: string, body?: unknown, app = APP_A): Promise<Json> {
  const answer = await dash(method, path, body, {
    app,
    user: app === APP_A ? 'owner_a' : 'owner_b',
  });
  expect([path, answer.status, answer.json]).toEqual([path, 200, answer.json]);
  return answer.json;
}

const data = (list: Json) => list.data as Json[];
const errorOf = (answer: { json: Json }) => answer.json.error as Json;

/** A committed Peable Tax sale (not registered: zero tax), at `at`. */
async function sale(
  merchant: MerchantRow,
  place: { country: string; state?: string },
  currency: string,
  amount: number,
  at: Date,
): Promise<string> {
  const evidence = await tax().recordEvidence(
    merchant,
    place.country === 'US'
      ? {
          customer_ref: 'payer_synthetic',
          evidence: [
            {
              type: 'billing_address',
              address: { country: 'US', state: place.state, postal_code: '00000' },
            },
          ],
        }
      : {
          customer_ref: 'payer_synthetic',
          evidence: [
            { type: 'billing_address', address: { country: place.country } },
            { type: 'payment_method_country', country: place.country },
          ],
        },
  );
  const calculation = await tax().calculate(
    merchant,
    {
      currency,
      customer_location_evidence_id: evidence.id,
      line_items: [{ reference: 'plan_synthetic', amount }],
    },
    { requireActive: false },
  );
  await commitTaxTransaction(gatewayDb(), {
    calculationPublicId: calculation.id,
    reference: `order_${calculation.id}`,
    rail: 'faircoin',
    committedAt: at,
  });
  const [row] = await gatewayDb()
    .select({ publicId: taxTransactions.publicId })
    .from(taxTransactions)
    .where(eq(taxTransactions.reference, `order_${calculation.id}`));
  return row?.publicId ?? '';
}

async function taxDocumentFile(
  merchant: MerchantRow,
  purpose: 'tax_document' | 'dispute_evidence' = 'tax_document',
) {
  return insertFile(gatewayDb(), {
    publicId: newId('file'),
    merchantId: merchant.id,
    purpose,
    oxyFileId: `oxyfile_${crypto.randomUUID()}`,
    filename: 'certificate.pdf',
    size: 1024,
    type: 'pdf',
  });
}

const yesterday = () => new Date(Date.now() - 86_400_000);
const monthsAgo = (n: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 10));
};

useGatewayDatabase();

beforeAll(() => {
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (_req, _res, next) => next(),
    requireOxyUser: (_req, res) => {
      res.status(401).end();
    },
  });
  gateway.httpServer.listen(0);
  apiUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(
    createDashboardTaxComplianceRouter({
      requireOxyUser: (req, _res, next) => {
        const userId = req.header('X-Test-User-Id') ?? 'owner_a';
        (req as OxyAuthRequest).userId = userId;
        (req as OxyAuthRequest).accessToken = `token-for-${userId}`;
        next();
      },
      assertAppMembership: async (userId: string, applicationId: string) =>
        MEMBERS[userId]?.[applicationId] ?? { allowed: false },
    }),
  );
  dashboardServer = app.listen(0);
  dashboardUrl = `http://127.0.0.1:${(dashboardServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  gateway?.io.close();
  gateway?.httpServer.close();
  dashboardServer?.close();
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('tax compliance', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    merchantA = await seedMerchant({
      oxyAppId: APP_A,
      environment: 'production',
      network: 'mainnet',
    });
    merchantB = await seedMerchant({
      oxyAppId: APP_B,
      environment: 'production',
      network: 'mainnet',
    });
  });

  test('onboarding: profile, locations, destinations, declarations and documents, each in the history', async () => {
    const before = await owner('GET', '/business_profile');
    expect(before).toMatchObject({
      object: 'tax.business_profile',
      livemode: true,
      entity_type: 'unknown',
      missing: [
        'legal_name',
        'entity_type',
        'customer_types',
        'establishment',
        'sales_destinations',
      ],
    });
    const profile = await owner('POST', '/business_profile', {
      entity_type: 'corporation',
      customer_types: 'consumers',
      supply_types: ['software_as_a_service'],
      metadata: { onboarding: 'v1' },
    });
    expect(profile).toMatchObject({
      entity_type: 'corporation',
      updated_by: 'owner_a',
      metadata: { onboarding: 'v1' },
    });

    const hq = await owner('POST', '/operating_locations', {
      kind: 'head_office',
      country: 'US',
      state: 'DE',
    });
    expect(String(hq.id)).toMatch(/^taxol_[0-9a-f]{24}$/);
    await owner('POST', '/sales_destinations', { country: 'NL', customer_types: 'consumers' });
    const declared = await owner('POST', '/registration_declarations', {
      country: 'US',
      state: 'TX',
      status: 'unknown',
    });
    expect(declared).toMatchObject({
      object: 'tax.registration_declaration',
      status: 'unknown',
      verification: { status: 'unverified', reason: 'no_authority_integration' },
      collection_registration: null,
    });
    expect((await owner('GET', '/business_profile')).missing).toEqual(['legal_name']);

    const file = await taxDocumentFile(merchantA);
    const document = await owner('POST', '/documents', {
      file: file.publicId,
      kind: 'incorporation_record',
      country: 'US',
      state: 'DE',
    });
    expect(document).toMatchObject({
      object: 'tax.document',
      file: file.publicId,
      file_status: 'available',
    });
    // A retry with the same file is the same document — never a second one.
    expect((await owner('POST', '/documents', { file: file.publicId, kind: 'other' })).id).toBe(
      document.id,
    );
    expect(data(await owner('GET', '/documents'))).toHaveLength(1);

    const history = data(await owner('GET', '/compliance_actions?limit=100'));
    expect(history.map((row) => row.action).reverse()).toEqual([
      'business_profile.updated',
      'operating_location.created',
      'sales_destination.created',
      'registration_declaration.created',
      'document.attached',
    ]);
    expect(
      history.every(
        (row) => (row.actor as Json).type === 'user' && (row.actor as Json).id === 'owner_a',
      ),
    ).toBe(true);
  });

  test('a removed file makes its document, and its checklist item, unavailable', async () => {
    const declared = await owner('POST', '/registration_declarations', {
      country: 'US',
      state: 'TX',
      scheme: 'us_state_sales_tax',
      status: 'registered',
      effective_from: 1_735_689_600,
    });
    let checklist = await owner('GET', '/document_checklist');
    const key = `registration_certificate:${declared.id}`;
    const item = () => (checklist.items as Json[]).find((each) => each.key === key);
    expect(item()).toMatchObject({ status: 'missing' });
    const file = await taxDocumentFile(merchantA);
    await owner('POST', '/documents', {
      file: file.publicId,
      kind: 'registration_certificate',
      registration_declaration: declared.id,
    });
    checklist = await owner('GET', '/document_checklist');
    expect(item()).toMatchObject({ status: 'provided' });
    await gatewayDb()
      .update(files)
      .set({ removedAt: new Date(), removedBy: 'file.deleted' })
      .where(eq(files.id, file.id));
    checklist = await owner('GET', '/document_checklist');
    expect(item()).toMatchObject({ status: 'unavailable' });
    expect(data(await owner('GET', '/documents'))[0]?.file_status).toBe('removed');
  });

  test('permissions: billing:read looks, billing:manage changes, a service credential decides nothing', async () => {
    expect((await dash('GET', '/business_profile', undefined, { user: 'viewer_a' })).status).toBe(
      200,
    );
    expect(
      (await dash('POST', '/business_profile', { entity_type: 'other' }, { user: 'viewer_a' }))
        .status,
    ).toBe(403);
    expect((await dash('POST', '/assessments', {}, { user: 'viewer_a' })).status).toBe(403);
    expect(
      (await dash('GET', '/business_profile', undefined, { user: 'developer_a' })).status,
    ).toBe(403);
    expect((await dash('GET', '/business_profile', undefined, { user: 'stranger' })).status).toBe(
      403,
    );
    // The merchant API reads and assesses; onboarding facts and decisions are not on it.
    expect((await api('GET', '/business_profile')).status).toBe(200);
    expect((await api('POST', '/business_profile', { entity_type: 'other' })).status).toBe(404);
    expect(
      (await api('POST', '/registration_declarations', { country: 'US', status: 'unknown' }))
        .status,
    ).toBe(404);
    const assessed = await api('POST', '/assessments', {});
    expect(assessed.status).toBe(200);
    expect(assessed.json.created_by).toEqual({ type: 'service', id: APP_A });
    const items = data((await api('GET', '/review_items')).json);
    if (items[0]) {
      expect(
        (await api('POST', `/review_items/${items[0].id}/resolve`, { decision: 'dismissed' }))
          .status,
      ).toBe(404);
    }
  });

  test('tenant isolation: another merchant is not found, and its file cannot be attached', async () => {
    const location = await owner('POST', '/operating_locations', { kind: 'office', country: 'FR' });
    const otherFile = await taxDocumentFile(merchantB);
    const ownEvidence = await taxDocumentFile(merchantA, 'dispute_evidence');
    // B's owner, on B's application, cannot reach A's location by naming it.
    expect(
      (
        await dash('GET', `/operating_locations/${location.id}`, undefined, {
          user: 'owner_b',
          app: APP_B,
        })
      ).status,
    ).toBe(404);
    expect(data(await owner('GET', '/operating_locations', undefined, APP_B))).toEqual([]);
    // A's owner on B's application is not a member there.
    expect((await dash('GET', '/business_profile', undefined, { app: APP_B })).status).toBe(403);
    // Through the API, B's credential sees nothing of A.
    expect(
      (await api('GET', `/operating_locations/${location.id}`, undefined, { 'X-Test-App': APP_B }))
        .status,
    ).toBe(404);
    for (const file of [otherFile.publicId, ownEvidence.publicId]) {
      const refused = await dash('POST', '/documents', { file, kind: 'other' });
      expect([refused.status, errorOf(refused).code, errorOf(refused).param]).toEqual([
        400,
        'invalid_tax_document',
        'file',
      ]);
    }
    // A collection registration of B cannot be linked to A's declaration.
    const bRegistration = await tax().createRegistration(merchantB, {
      country: 'US',
      state: 'TX',
      scheme: 'us_state_sales_tax',
    });
    const linked = await dash('POST', '/registration_declarations', {
      country: 'US',
      state: 'TX',
      status: 'unknown',
      collection_registration: bRegistration.id,
    });
    expect([linked.status, errorOf(linked).param]).toEqual([400, 'collection_registration']);
    // An assessment of A never counts B's sales.
    await sale(merchantB, { country: 'NL' }, 'EUR', 50_000, yesterday());
    await owner('POST', '/operating_locations', {
      kind: 'head_office',
      country: 'US',
      state: 'DE',
    });
    const assessment = await owner('POST', '/assessments', {});
    const eu = (assessment.results as Json[]).find((r) => r.rule === 'eu_vat_b2c_cross_border');
    expect(eu?.outcome).toBe('not_indicated');
  });

  test('an assessment escalates; a second one keeps the same open items; replay matches; events recorded', async () => {
    await owner('POST', '/operating_locations', {
      kind: 'head_office',
      country: 'US',
      state: 'DE',
    });
    await sale(merchantA, { country: 'NL' }, 'EUR', 1_999, monthsAgo(1));
    await sale(merchantA, { country: 'JP' }, 'JPY', 500, monthsAgo(1));
    const first = await owner('POST', '/assessments', {});
    expect(first).toMatchObject({ object: 'tax.assessment', rule_set_version: '2026-11-03.1' });
    expect(String(first.inputs_digest)).toMatch(/^[0-9a-f]{64}$/);
    const results = first.results as Json[];
    const eu = results.find((r) => r.rule === 'eu_vat_b2c_cross_border');
    expect(eu).toMatchObject({ outcome: 'likely_required' });
    expect(results.find((r) => r.country === 'JP')).toMatchObject({
      outcome: 'unsupported',
      measured: null,
    });
    const open = data(await owner('GET', '/review_items?status=open'));
    expect(open.map((item) => item.code).sort()).toEqual([
      'registration_likely_required',
      'unsupported_jurisdiction_sales',
    ]);

    const second = await owner('POST', '/assessments', {});
    expect(data(await owner('GET', '/review_items')).length).toBe(2);
    const reopened = data(await owner('GET', '/review_items?status=open'));
    expect(
      reopened.every(
        (item) => item.first_assessment === first.id && item.latest_assessment === second.id,
      ),
    ).toBe(true);

    const replay = await owner('GET', `/assessments/${first.id}/replay`);
    expect(replay).toMatchObject({
      object: 'tax.assessment_replay',
      matches: true,
      inputs_digest: first.inputs_digest,
    });

    const types = (await storedEvents({ merchantId: merchantA.id })).map(({ row }) => row.type);
    expect(types.filter((type) => type === 'tax.assessment.created')).toHaveLength(2);
    expect(types.filter((type) => type === 'tax.review_item.created')).toHaveLength(2);
  });

  test('assessments are versioned and replay the stored inputs, not the current facts', async () => {
    await owner('POST', '/operating_locations', { kind: 'head_office', country: 'IE' });
    await sale(merchantA, { country: 'FR' }, 'EUR', 900_000, yesterday());
    const assessment = await owner('POST', '/assessments', {});
    expect((assessment.results as Json[])[0]?.outcome).toBe('approaching_threshold');
    // The facts move on; the stored assessment still replays to what it said.
    await sale(merchantA, { country: 'FR' }, 'EUR', 900_000, yesterday());
    const replay = await owner('GET', `/assessments/${assessment.id}/replay`);
    expect(replay.matches).toBe(true);
    expect(((replay.results as Json[])[0] as Json).outcome).toBe('approaching_threshold');
    const fresh = await owner('POST', '/assessments', {});
    expect((fresh.results as Json[])[0]?.outcome).toBe('likely_required');
  });

  test('reconciliation: measured Texas revenue nets reversals exactly as the transactions do', async () => {
    const window = monthsAgo(2);
    const one = await sale(merchantA, { country: 'US', state: 'TX' }, 'USD', 30_000, window);
    await sale(merchantA, { country: 'US', state: 'TX' }, 'USD', 20_000, window);
    // A refund last month, inside the window, nets into it.
    await createTaxService({ db: gatewayDb(), now: () => monthsAgo(1) }).createReversal(
      merchantA,
      one,
      {
        reference: 'refund_synthetic',
        amount: 5_000,
      },
    );
    // A refund NOW falls in the month in progress, outside the preceding
    // twelve calendar months, and is not counted yet.
    await tax().createReversal(merchantA, one, { reference: 'refund_today', amount: 1_000 });
    const assessment = await owner('POST', '/assessments', {});
    const tx = (assessment.results as Json[]).find((r) => r.rule === 'us_tx_sales_tax');
    const measured = (tx?.measured ?? {}) as Json;
    expect(measured.amount).toBe('45000');
    // Transactions count sales, never reversals.
    expect(measured.transactions).toBe(2);
    // The same netting the transaction list shows: sum of originals plus signed reversals.
    const rows = await gatewayDb()
      .select({ reversal: taxTransactions.reversal })
      .from(taxTransactions)
      .where(eq(taxTransactions.merchantId, merchantA.id));
    const reversed = rows.reduce((sum, row) => sum + (row.reversal?.amount_net ?? 0), 0);
    expect(50_000 + reversed).toBe(44_000);
  });

  test('an ended registration with later sales, and an ambiguous pending application, go to the queue', async () => {
    await owner('POST', '/registration_declarations', {
      country: 'US',
      state: 'TX',
      scheme: 'us_state_sales_tax',
      status: 'ended',
      effective_from: Math.floor(+monthsAgo(14) / 1000),
      effective_to: Math.floor(+monthsAgo(6) / 1000),
    });
    await owner('POST', '/registration_declarations', {
      country: 'US',
      state: 'TX',
      scheme: 'us_state_sales_tax',
      status: 'application_pending',
    });
    await sale(merchantA, { country: 'US', state: 'TX' }, 'USD', 1_000, monthsAgo(2));
    const assessment = await owner('POST', '/assessments', {});
    const tx = (assessment.results as Json[]).find((r) => r.rule === 'us_tx_sales_tax');
    expect(tx?.outcome).not.toBe('registration_declared');
    const codes = data(await owner('GET', '/review_items?limit=100')).map((item) => item.code);
    expect(codes).toContain('sales_after_registration_ended');
    expect(codes).toContain('application_pending');
    // An ended registration without an end date, or one ending before it began, is refused.
    const undated = await dash('POST', '/registration_declarations', {
      country: 'US',
      state: 'TX',
      status: 'ended',
      effective_from: 1,
    });
    expect([undated.status, errorOf(undated).param]).toEqual([400, 'effective_to']);
  });

  test('owner decisions: recorded with who and when, once — a second decision is refused', async () => {
    await owner('POST', '/registration_declarations', {
      country: 'US',
      state: 'TX',
      status: 'unknown',
    });
    await owner('POST', '/assessments', {});
    const [item] = data(await owner('GET', '/review_items?status=open'));
    expect(item?.code).toBe('registration_status_unknown');
    const needsNote = await dash('POST', `/review_items/${item?.id}/resolve`, {
      decision: 'not_required',
    });
    expect([needsNote.status, errorOf(needsNote).param]).toEqual([400, 'note']);
    const [a, b] = await Promise.all([
      dash('POST', `/review_items/${item?.id}/resolve`, {
        decision: 'facts_corrected',
        note: 'checked',
      }),
      dash('POST', `/review_items/${item?.id}/resolve`, { decision: 'dismissed' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(errorOf(loser).code).toBe('review_item_not_open');
    const decided = await owner('GET', `/review_items/${item?.id}`);
    expect(decided.decision).toMatchObject({ decided_by: 'owner_a' });
    const types = (await storedEvents({ merchantId: merchantA.id })).map(({ row }) => row.type);
    expect(types.filter((type) => type === 'tax.review_item.updated')).toHaveLength(1);
  });

  test('a retried assessment with the same Idempotency-Key is the same assessment', async () => {
    const headers = { 'Idempotency-Key': 'assess-once' };
    const first = await dash('POST', '/assessments', {}, { headers });
    const again = await dash('POST', '/assessments', {}, { headers });
    expect(again.json.id).toBe(first.json.id);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    const viaApi = await api('POST', '/assessments', {}, { 'Idempotency-Key': 'api-once' });
    const viaApiAgain = await api('POST', '/assessments', {}, { 'Idempotency-Key': 'api-once' });
    expect(viaApiAgain.json.id).toBe(viaApi.json.id);
    expect(data(await owner('GET', '/assessments'))).toHaveLength(2);
  });

  test('nothing here activates collection, and the approval still fails closed when the provider is down', async () => {
    await owner('POST', '/registration_declarations', {
      country: 'US',
      state: 'TX',
      scheme: 'us_state_sales_tax',
      status: 'registered',
      effective_from: 1_735_689_600,
    });
    await owner('POST', '/assessments', {});
    const [settings] = await gatewayDb()
      .select()
      .from(taxSettings)
      .where(eq(taxSettings.merchantId, merchantA.id));
    expect(settings?.status ?? 'draft').toBe('draft');
    expect(await tax().listRegistrations(merchantA)).toEqual([]);
    // A Texas sale is still priced as not registered: a declaration is not collection.
    const evidence = await tax().recordEvidence(merchantA, {
      customer_ref: 'payer_synthetic',
      evidence: [
        { type: 'billing_address', address: { country: 'US', state: 'TX', postal_code: '00000' } },
      ],
    });
    const calculation = await tax().calculate(
      merchantA,
      {
        currency: 'USD',
        customer_location_evidence_id: evidence.id,
        line_items: [{ reference: 'p', amount: 100 }],
      },
      { requireActive: false },
    );
    expect(calculation.collection).toBe('not_registered');
    // Provider outage: the owner's approval refuses rather than activating anything.
    const down: TaxProvider = {
      id: 'down',
      livemode: true,
      async status() {
        throw new TaxProviderUnavailableError('timeout');
      },
      async ensureHeadOffice() {
        throw new TaxProviderUnavailableError('timeout');
      },
      async calculate() {
        throw new TaxProviderUnavailableError('timeout');
      },
    };
    const withProvider = createTaxService({ db: gatewayDb(), providers: [down] });
    await withProvider.updateSettings(merchantA, {
      legal_name: 'Synthetic Seller',
      head_office: { country: 'US', state: 'DE' },
    });
    await withProvider.createRegistration(merchantA, {
      country: 'US',
      state: 'TX',
      scheme: 'us_state_sales_tax',
    });
    const refused = await withProvider
      .approve(merchantA, { userId: 'owner_a', officialApplication: true })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TaxError);
    expect((refused as TaxError).code).toBe('tax_calculation_unavailable');
    expect((await withProvider.getSettings(merchantA)).status).toBe('draft');
    // And the compliance surface still answers through the outage.
    expect((await owner('POST', '/assessments', {})).object).toBe('tax.assessment');
  });

  test('capabilities and deadlines state what is not available instead of simulating it', async () => {
    const capabilities = await owner('GET', '/capabilities');
    const status = Object.fromEntries(
      (capabilities.capabilities as Json[]).map((each) => [each.id, each.status]),
    );
    expect(status).toMatchObject({
      registration_submission: 'not_available',
      registration_verification: 'not_available',
      return_filing: 'not_available',
      remittance: 'not_available',
      corporate_income_tax: 'out_of_scope',
      annual_company_filings: 'out_of_scope',
    });
    await owner('POST', '/registration_declarations', {
      country: 'IE',
      scheme: 'eu_oss_non_union',
      status: 'registered',
      effective_from: 1_735_689_600,
    });
    await owner('POST', '/registration_declarations', {
      country: 'US',
      state: 'TX',
      scheme: 'us_state_sales_tax',
      status: 'registered',
      effective_from: 1_735_689_600,
    });
    const deadlines = await owner('GET', '/deadlines');
    const returns = data(deadlines).filter((each) => each.kind === 'return');
    expect(returns.length).toBeGreaterThan(0);
    for (const each of data(deadlines)) expect(each.filing_status).toBe('not_tracked');
    expect((deadlines.unavailable as Json[]).map((each) => each.rule)).toEqual(['us_tx_sales_tax']);
    const rules = await api('GET', '/rule_set');
    expect(rules.json).toMatchObject({ object: 'tax.rule_set', version: '2026-11-03.1' });
  });
});
