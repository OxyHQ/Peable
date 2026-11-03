/**
 * Answering a dispute — Stripe's `POST /v1/disputes/:id` and `…/close`, over
 * HTTP, against a real database, a fake provider that keeps a DRAFT the way
 * Stripe does, and a fake Oxy Files holding the merchant's evidence uploads.
 *
 * The properties that matter more than the happy path, each with a case:
 *  - a draft lives at the PROVIDER and none of its words are stored here —
 *    not on the dispute row, not in an event;
 *  - files are attached by id and their bytes reach the provider only at
 *    submission, each under a key derived from the dispute, field and File;
 *  - a response is submitted ONCE: a second submission, or a draft after one,
 *    is refused without calling the provider;
 *  - a deadline that has passed, a closed dispute, an empty response, an
 *    unknown field and another merchant's file or dispute are refused here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { ProviderMode } from '../../services/providers/provider';

interface ProviderCall {
  readonly fn: string;
  readonly request: Record<string, unknown>;
}
const providerCalls: ProviderCall[] = [];
/** Stripe's draft store: the staged evidence of each provider dispute. */
const drafts = new Map<string, Record<string, string>>();
let failNext: Error | null = null;

const TEXT = [
  'access_activity_log',
  'billing_address',
  'cancellation_policy_disclosure',
  'cancellation_rebuttal',
  'customer_email_address',
  'customer_name',
  'customer_purchase_ip',
  'duplicate_charge_explanation',
  'product_description',
  'refund_policy_disclosure',
  'refund_refusal_explanation',
  'service_date',
  'shipping_address',
  'shipping_carrier',
  'shipping_date',
  'shipping_tracking_number',
  'uncategorized_text',
];

function snapshot(id: string, status: string) {
  const draft = drafts.get(id) ?? {};
  return {
    status,
    hasEvidence: Object.values(draft).some((value) => value.length > 0),
    submissionCount: status === 'under_review' ? 1 : 0,
    isChargeRefundable: true,
    evidence: Object.fromEntries(TEXT.map((field) => [field, draft[field] || null])),
  };
}

const fakeProvider = {
  id: 'stripe' as const,
  updateDisputeEvidence: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: 'updateDisputeEvidence', request });
    if (failNext) {
      const error = failNext;
      failNext = null;
      throw error;
    }
    const id = String(request.providerObjectId);
    drafts.set(id, { ...(drafts.get(id) ?? {}), ...(request.evidence as Record<string, string>) });
    return snapshot(id, request.submit ? 'under_review' : 'needs_response');
  },
  getDispute: async (providerObjectId: string) => {
    providerCalls.push({ fn: 'getDispute', request: { providerObjectId } });
    return snapshot(providerObjectId, 'needs_response');
  },
  closeDispute: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: 'closeDispute', request });
    return snapshot(String(request.providerObjectId), 'lost');
  },
  uploadDisputeEvidenceFile: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: 'uploadDisputeEvidenceFile', request });
    return { providerFileId: `file_stripe_${String(request.idempotencyKey).split(':').at(-1)}` };
  },
  createPayment: async () => {
    throw new Error('not used');
  },
  confirm: async () => {
    throw new Error('not used');
  },
  capture: async () => {
    throw new Error('not used');
  },
  cancel: async () => {
    throw new Error('not used');
  },
  refund: async () => {
    throw new Error('not used');
  },
  getStatus: async () => {
    throw new Error('not used');
  },
  verifyEvent: async () => {
    throw new Error('not used');
  },
};

const realRegistry = await import('../../services/providers/registry');
const {
  resolveProvider: realResolveProvider,
  resolveCardProvider: realResolveCardProvider,
  resetProviders: realResetProviders,
} = realRegistry;
let useFake = false;

mock.module('../../services/providers/registry', () => ({
  ...realRegistry,
  resolveProvider: (id: 'stripe', mode: ProviderMode) =>
    useFake ? fakeProvider : realResolveProvider(id, mode),
  resolveCardProvider: (mode: ProviderMode) =>
    useFake ? fakeProvider : realResolveCardProvider(mode),
  resetProviders: () => {
    realResetProviders();
  },
}));

const { createDisputesRouter } = await import('../disputes');
const { createFilesRouter } = await import('../files');
const { createFakeOxyFiles } = await import('../../__tests__/helpers/fakeOxyFiles');
const { upsertDispute, findDisputeByProviderObject } = await import(
  '../../db/disputes/disputeRepository'
);
const { gatewayDb, seedIntent, seedMerchant, storedEvents, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let other: Merchant;
/** Which merchant the next request authenticates as. */
let actingAs: () => Merchant;
let server: Server;
let baseUrl = '';
let counter = 0;
const files = createFakeOxyFiles();

type Json = Record<string, unknown> & {
  error?: { type: string; code?: string; param?: string; message: string };
};

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Json) : {},
    headers: response.headers,
  };
}

const PDF = new TextEncoder().encode('%PDF-1.7\nreceipt for order 1001\n%%EOF');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function upload(purpose: string, bytes: Uint8Array, name = 'receipt.pdf'): Promise<string> {
  const form = new FormData();
  form.set('purpose', purpose);
  form.set('file', new Blob([bytes]), name);
  const response = await fetch(`${baseUrl}/v1/files`, { method: 'POST', body: form });
  const json = (await response.json()) as { id: string };
  expect(response.status).toBe(200);
  return json.id;
}

/** A dispute in the one state that accepts a response. */
async function openDispute(
  options: { dueAt?: Date | null; status?: 'needs_response' | 'won'; owner?: Merchant } = {},
) {
  counter += 1;
  const owner = options.owner ?? merchant;
  const intent = await seedIntent(owner, { rail: 'card', currency: 'EUR', amount: '5000' });
  const { dispute } = await upsertDispute(gatewayDb(), {
    merchantId: owner.id,
    paymentIntentId: intent.id,
    provider: 'stripe',
    providerObjectId: `du_stripe_${String(counter)}`,
    amount: '5000',
    currency: 'EUR',
    status: options.status ?? 'needs_response',
    reason: 'fraudulent',
    evidenceDueAt:
      options.dueAt === undefined ? new Date(Date.now() + 7 * 86_400_000) : options.dueAt,
  });
  return dispute;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('answering a dispute', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
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
        ownerAccountId: 'owner',
        environment: 'development',
        tier: 'external',
      };
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(createDisputesRouter({ requireMerchant: stubAuth, files }));
    app.use(createFilesRouter({ requireMerchant: stubAuth, files }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    failNext = null;
    actingAs = () => merchant;
  });

  afterAll(async () => {
    useFake = false;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  test('a draft is staged at the provider, read back live, and none of it is stored', async () => {
    const dispute = await openDispute();
    const { status, json } = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { customer_name: 'Jane Buyer', product_description: 'A blue enamel mug' },
    });

    expect(status).toBe(200);
    expect(json.object).toBe('dispute');
    expect((json.evidence as Record<string, unknown>).customer_name).toBe('Jane Buyer');
    expect((json.evidence as Record<string, unknown>).receipt).toBeNull();
    const details = json.evidence_details as Record<string, unknown>;
    expect(details.has_evidence).toBe(true);
    expect(details.submission_count).toBe(0);
    // A draft is NOT a submission, and carries no idempotency key.
    const update = providerCalls.find((entry) => entry.fn === 'updateDisputeEvidence');
    expect(update?.request.submit).toBe(false);
    expect(update?.request.idempotencyKey).toBeUndefined();

    // Read back LIVE from the provider, where the draft lives.
    const read = await call('GET', `/v1/disputes/${dispute.publicId}`);
    expect((read.json.evidence as Record<string, unknown>).product_description).toBe(
      'A blue enamel mug',
    );

    // The row and the stored events hold the FACT, never the words.
    const row = await findDisputeByProviderObject(gatewayDb(), 'stripe', dispute.providerObjectId);
    expect(row?.hasEvidence).toBe(true);
    expect(JSON.stringify(row)).not.toContain('Jane Buyer');
    const events = await storedEvents({ merchantId: merchant.id });
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('Jane Buyer');
    expect(JSON.stringify(events)).not.toContain('enamel');
  });

  test('a list item carries no evidence; the retrieve does', async () => {
    const dispute = await openDispute();
    const list = await call('GET', '/v1/disputes');
    const item = (list.json.data as Record<string, unknown>[]).find(
      (entry) => entry.id === dispute.publicId,
    );
    expect(item).toBeDefined();
    expect(item?.evidence).toBeUndefined();
    expect(item?.reason).toBe('fraudulent');
    expect(item?.is_charge_refundable).toBe(false);
  });

  test('files are attached by id; their bytes reach the provider only at submission, once', async () => {
    const dispute = await openDispute();
    const receipt = await upload('dispute_evidence', PDF);

    const staged = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { receipt, uncategorized_text: 'Delivered and signed for.' },
    });
    expect(staged.status).toBe(200);
    expect((staged.json.evidence as Record<string, unknown>).receipt).toBe(receipt);
    // Nothing was uploaded to the provider by a draft.
    expect(providerCalls.filter((entry) => entry.fn === 'uploadDisputeEvidenceFile')).toHaveLength(
      0,
    );

    providerCalls.length = 0;
    const submitted = await call('POST', `/v1/disputes/${dispute.publicId}`, { submit: true });
    expect(submitted.status).toBe(200);
    const details = submitted.json.evidence_details as Record<string, unknown>;
    expect(details.submission_count).toBe(1);
    expect(details.submitted_at).not.toBeNull();
    expect(submitted.json.status).toBe('under_review');

    const uploadCall = providerCalls.find((entry) => entry.fn === 'uploadDisputeEvidenceFile');
    expect(uploadCall?.request.idempotencyKey).toBe(
      `dpfile:${dispute.publicId}:receipt:${receipt}`,
    );
    expect(Buffer.from(uploadCall?.request.bytes as Uint8Array).equals(Buffer.from(PDF))).toBe(
      true,
    );
    expect(uploadCall?.request.mime).toBe('application/pdf');
    const submitCall = providerCalls.find(
      (entry) => entry.fn === 'updateDisputeEvidence' && entry.request.submit === true,
    );
    expect(submitCall?.request.idempotencyKey).toBe(`dpev:${dispute.publicId}`);
    expect((submitCall?.request.evidence as Record<string, string> | undefined)?.receipt).toBe(
      `file_stripe_${receipt}`,
    );
  });

  test('a second submission is refused, and so is a draft after one', async () => {
    const dispute = await openDispute();
    const first = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { uncategorized_text: 'The goods were delivered.' },
      submit: true,
    });
    expect(first.status).toBe(200);

    providerCalls.length = 0;
    const second = await call('POST', `/v1/disputes/${dispute.publicId}`, { submit: true });
    expect(second.status).toBe(409);
    expect(second.json.error?.code).toBe('dispute_already_submitted');
    const late = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { uncategorized_text: 'One more thing.' },
    });
    expect(late.status).toBe(409);
    // Neither reached the provider.
    expect(providerCalls).toHaveLength(0);
  });

  test('a retried submission under the same Idempotency-Key replays the first answer', async () => {
    const dispute = await openDispute();
    const body = { evidence: { uncategorized_text: 'Signed for.' }, submit: true };
    const headers = { 'Idempotency-Key': `submit-${dispute.publicId}` };
    const first = await call('POST', `/v1/disputes/${dispute.publicId}`, body, headers);
    providerCalls.length = 0;
    const replay = await call('POST', `/v1/disputes/${dispute.publicId}`, body, headers);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(providerCalls).toHaveLength(0);
  });

  test('a submission with nothing in it is refused', async () => {
    const dispute = await openDispute();
    const { status, json } = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      submit: true,
    });
    expect(status).toBe(409);
    expect(json.error?.message).toContain('at least one field');
    expect(providerCalls.filter((entry) => entry.fn === 'updateDisputeEvidence')).toHaveLength(0);
  });

  test('refuses evidence after the deadline, and on a closed dispute', async () => {
    const late = await openDispute({ dueAt: new Date(Date.now() - 1000) });
    const lateAnswer = await call('POST', `/v1/disputes/${late.publicId}`, {
      evidence: { uncategorized_text: 'Late.' },
    });
    expect(lateAnswer.status).toBe(409);
    expect(lateAnswer.json.error?.message).toContain('deadline');

    const closed = await openDispute({ status: 'won', dueAt: null });
    const closedAnswer = await call('POST', `/v1/disputes/${closed.publicId}`, {
      evidence: { uncategorized_text: 'Anything.' },
    });
    expect(closedAnswer.status).toBe(409);
    expect(providerCalls).toHaveLength(0);
  });

  test('refuses a field name the network would not recognise', async () => {
    const dispute = await openDispute();
    const { status, json } = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { trackingNumber: 'TRACK-2' },
    });
    expect(status).toBe(400);
    expect(json.error?.type).toBe('invalid_request_error');
    expect(providerCalls).toHaveLength(0);
  });

  test("refuses a file that is not the merchant's own dispute evidence", async () => {
    const dispute = await openDispute();
    const logo = await upload('business_logo', PNG, 'logo.png');
    const asLogo = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { receipt: logo },
    });
    expect(asLogo.status).toBe(400);
    expect(asLogo.json.error?.param).toBe('evidence[receipt]');

    actingAs = () => other;
    const theirs = await upload('dispute_evidence', PDF);
    actingAs = () => merchant;
    const crossed = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { receipt: theirs },
    });
    expect(crossed.status).toBe(400);
    expect(providerCalls.filter((entry) => entry.fn === 'updateDisputeEvidence')).toHaveLength(0);
  });

  test('does not answer across merchants', async () => {
    const dispute = await openDispute({ owner: other });
    const { status } = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { uncategorized_text: 'Not mine to answer.' },
    });
    expect(status).toBe(404);
    expect((await call('GET', `/v1/disputes/${dispute.publicId}`)).status).toBe(404);
    expect(providerCalls).toHaveLength(0);
  });

  test('does not record a submission the provider refused', async () => {
    const dispute = await openDispute();
    const { ProviderError } = await import('../../services/providers/provider');
    failNext = new ProviderError({
      provider: 'stripe',
      stage: 'dispute',
      message: 'the acquirer could not be reached',
      retryable: true,
    });
    const { status } = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { uncategorized_text: 'Delivered and signed for.' },
      submit: true,
    });
    expect(status).toBe(502);
    const stored = await findDisputeByProviderObject(
      gatewayDb(),
      'stripe',
      dispute.providerObjectId,
    );
    expect(stored?.evidenceSubmittedAt).toBeNull();
  });

  test('close accepts the dispute: lost, told once, and closed for good', async () => {
    const dispute = await openDispute();
    const closed = await call('POST', `/v1/disputes/${dispute.publicId}/close`, {});
    expect(closed.status).toBe(200);
    expect(closed.json.status).toBe('lost');
    expect((closed.json.evidence_details as Record<string, unknown>).due_by).toBeNull();
    expect(providerCalls.find((entry) => entry.fn === 'closeDispute')?.request.idempotencyKey).toBe(
      `dpclose:${dispute.publicId}`,
    );
    const events = (
      await storedEvents({ merchantId: merchant.id, type: 'charge.dispute.closed' })
    ).filter(({ event }) => (event.data.object as { id?: string }).id === dispute.publicId);
    expect(events).toHaveLength(1);

    providerCalls.length = 0;
    const again = await call('POST', `/v1/disputes/${dispute.publicId}/close`, {});
    expect(again.status).toBe(409);
    const answer = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      evidence: { uncategorized_text: 'Changed my mind.' },
    });
    expect(answer.status).toBe(409);
    expect(providerCalls).toHaveLength(0);
  });

  test('metadata updates in any state and is a patch', async () => {
    const dispute = await openDispute({ status: 'won', dueAt: null });
    const first = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      metadata: { case: 'C-1', team: 'risk' },
    });
    expect(first.status).toBe(200);
    const second = await call('POST', `/v1/disputes/${dispute.publicId}`, {
      metadata: { team: '' },
    });
    expect(second.json.metadata).toEqual({ case: 'C-1' });
  });
});
