/**
 * What a payment came to — and the distinction the whole shape exists for.
 *
 * Issue #70 §13 names it: *"Representar `unknown/pending` frente a cero
 * conocido"*. A settlement report that renders a not-yet-known fee as `0` is
 * one a merchant reconciles against and cannot explain, and zero is a number
 * somebody will subtract. Every case below is about a figure being `null` with
 * a `status` rather than a number nobody measured.
 *
 * A refund and a dispute answer the same `settlement` object: one movement of
 * the balance each, `net` negative, `unknown` (never zeros) when there is no
 * movement — an inquiry, a refund the provider never acknowledged.
 *
 * What this does NOT do is attribute the cost to an entity. A fee paid by the
 * operator of a deployment is not automatically an expense of the marketplace
 * running on it, and that decision is still open — reporting the fact does not
 * prejudge it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProviderMode } from '../../services/providers/provider';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';

let settlementResponse: Record<string, unknown> = {};
let getSettlementThrows: Error | null = null;
const providerCalls: string[] = [];

const UNKNOWN = {
  status: 'unknown',
  gross: null,
  fee: null,
  net: null,
  currency: null,
  availableOn: null,
  exchangeRate: null,
};

const fakeProvider = {
  id: 'stripe' as const,
  getSettlement: async (chargeObjectId: string) => {
    providerCalls.push(`getSettlement:${chargeObjectId}`);
    if (getSettlementThrows) throw getSettlementThrows;
    return settlementResponse;
  },
  getRefundSettlement: async (refundObjectId: string) => {
    providerCalls.push(`getRefundSettlement:${refundObjectId}`);
    if (getSettlementThrows) throw getSettlementThrows;
    return settlementResponse;
  },
  getDisputeSettlement: async (disputeObjectId: string) => {
    providerCalls.push(`getDisputeSettlement:${disputeObjectId}`);
    if (getSettlementThrows) throw getSettlementThrows;
    // An inquiry: the provider has no withdrawal to report.
    return disputeObjectId.startsWith('du_inquiry') ? UNKNOWN : settlementResponse;
  },
  createPayment: async () => {
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

const { createRefundsRouter } = await import('../refunds');
const { createDisputesRouter } = await import('../disputes');
const { insertRefund, linkRefundObject } = await import('../../db/refunds/refundRepository');
const { upsertDispute } = await import('../../db/disputes/disputeRepository');
const { linkProviderCharge, linkProviderObject } = await import(
  '../../db/payments/paymentIntentRepository'
);
const { gatewayDb, seedIntent, seedMerchant, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let server: Server;
let baseUrl = '';
let counter = 0;

interface Body {
  readonly object?: string;
  readonly payment_intent?: string | { readonly id?: string };
  readonly refund?: string | { readonly id?: string; readonly object?: string } | null;
  readonly dispute?: string | { readonly id?: string; readonly object?: string } | null;
  readonly status?: string;
  readonly gross?: string | null;
  readonly fee?: string | null;
  readonly net?: string | null;
  readonly currency?: string | null;
  readonly available_on?: number | null;
  readonly exchange_rate?: number | null;
}

async function get(path: string): Promise<{ status: number; json: Body }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as Body };
}

/** A card payment with a charge recorded against it. */
async function chargedIntent() {
  counter += 1;
  const intent = await seedIntent(merchant, {
    publicId: `pi_settle_${String(counter)}`,
    rail: 'card',
    currency: 'EUR',
    amount: '10000',
  });
  await linkProviderObject(gatewayDb(), intent.id, 'stripe', `pi_stripe_${intent.publicId}`);
  await linkProviderCharge(gatewayDb(), intent.id, 'stripe', `ch_stripe_${intent.publicId}`);
  return intent;
}

/** A refund of `intent`, acknowledged by the provider unless `linked` is false. */
async function refundOf(intent: Awaited<ReturnType<typeof chargedIntent>>, linked = true) {
  counter += 1;
  const refund = await insertRefund(gatewayDb(), {
    publicId: `re_settle_${String(counter)}`,
    merchantId: intent.merchantId,
    paymentIntentId: intent.id,
    externalRef: `order_refund_${String(counter)}`,
    amount: '1000',
    currency: intent.currency,
    provider: 'stripe',
  });
  if (!refund) throw new Error('the refund was not inserted');
  if (!linked) return refund;
  const withObject = await linkRefundObject(gatewayDb(), refund.id, `re_stripe_${refund.publicId}`);
  if (!withObject) throw new Error('the refund was not linked');
  return withObject;
}

/** A dispute against `intent`; `du_inquiry…` is one the fake reports no movement for. */
async function disputeOf(intent: Awaited<ReturnType<typeof chargedIntent>>, inquiry = false) {
  counter += 1;
  const { dispute } = await upsertDispute(gatewayDb(), {
    merchantId: intent.merchantId,
    paymentIntentId: intent.id,
    provider: 'stripe',
    providerObjectId: `${inquiry ? 'du_inquiry' : 'du_stripe'}_${String(counter)}`,
    amount: '5000',
    currency: 'EUR',
    status: 'needs_response',
  });
  return dispute;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('reporting what a payment came to', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    merchant = await seedMerchant();

    const stubAuth: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: merchant.oxyAppId,
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
    app.use(createRefundsRouter({ requireMerchant: stubAuth }));
    app.use(createDisputesRouter({ requireMerchant: stubAuth }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    getSettlementThrows = null;
    settlementResponse = {
      status: 'available',
      gross: '10000',
      fee: '204',
      net: '9796',
      currency: 'EUR',
      availableOn: new Date('2026-09-26T00:00:00.000Z'),
      exchangeRate: null,
    };
  });

  afterAll(async () => {
    useFake = false;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  test('reports gross, fee and net when the provider has settled it', async () => {
    const intent = await chargedIntent();

    const { status, json } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(status).toBe(200);
    expect(json.object).toBe('settlement');
    expect(json.payment_intent).toBe(intent.publicId);
    // A payment's own settlement: neither a refund's nor a dispute's.
    expect(json.refund).toBeNull();
    expect(json.dispute).toBeNull();
    expect(json.status).toBe('available');
    expect(json.fee).toBe('204');
    expect(json.net).toBe('9796');
    expect(json.available_on).toBe(Date.parse('2026-09-26T00:00:00.000Z') / 1000);
    // The CHARGE, not the payment: fees attach to the charge.
    expect(providerCalls).toContain(`getSettlement:ch_stripe_${intent.publicId}`);
  });

  /**
   * A settlement that exists and is not final says `pending` — with the figures
   * it does have, because they are known even though they may still move.
   */
  test('says pending rather than final when the provider has not settled it', async () => {
    settlementResponse = { ...settlementResponse, status: 'pending' };
    const intent = await chargedIntent();

    const { json } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(json.status).toBe('pending');
    expect(json.fee).toBe('204');
  });

  /**
   * THE case. A payment with no charge has no balance transaction — it has not
   * been captured, or the two-step create never linked. Every figure is `null`
   * and the status says why.
   */
  test('says unknown, not zero, when there is nothing to report', async () => {
    const intent = await seedIntent(merchant, {
      publicId: `pi_uncharged_${String(Date.now())}`,
      rail: 'card',
      currency: 'EUR',
      amount: '10000',
    });

    const { json } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(json.status).toBe('unknown');
    expect(json.gross).toBeNull();
    expect(json.fee).toBeNull();
    expect(json.net).toBeNull();
    expect(json.currency).toBeNull();
    // Never asked the provider — there is no charge to ask about.
    expect(providerCalls).toHaveLength(0);
  });

  /**
   * The FairCoin rail takes no fee and has no acquirer balance. Reporting `0`
   * would be a claim about a settlement that does not work that way at all.
   */
  test('says unknown for a rail that has no settlement', async () => {
    const intent = await seedIntent(merchant);

    const { json } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(json.status).toBe('unknown');
    expect(json.fee).toBeNull();
    expect(providerCalls).toHaveLength(0);
  });

  /**
   * A provider that cannot be reached knows the answer; we do not. `unknown` is
   * the honest response, and it keeps a reconciliation read from failing
   * because of an outage elsewhere.
   */
  test('says unknown rather than failing when the provider is unreachable', async () => {
    const intent = await chargedIntent();
    getSettlementThrows = new Error('the acquirer could not be reached');

    const { status, json } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(status).toBe(200);
    expect(json.status).toBe('unknown');
    expect(json.net).toBeNull();
  });

  test("does not report another merchant's payment", async () => {
    const other = await seedMerchant();
    const intent = await seedIntent(other, { rail: 'card', currency: 'EUR' });

    const { status } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(status).toBe(404);
  });

  /**
   * What a refund took off the balance, in the settlement currency — the
   * figure a marketplace books the refund at. `net` is negative: the balance
   * went down.
   */
  test("reports a refund's own movement, beside the payment it refunded", async () => {
    settlementResponse = {
      status: 'available',
      gross: '921',
      fee: '0',
      net: '-921',
      currency: 'EUR',
      availableOn: new Date('2026-09-26T00:00:00.000Z'),
      exchangeRate: 0.921,
    };
    const intent = await chargedIntent();
    const refund = await refundOf(intent);

    const { status, json } = await get(`/v1/refunds/${refund.publicId}/settlement`);

    expect(status).toBe(200);
    expect(json.object).toBe('settlement');
    expect(json.refund).toBe(refund.publicId);
    expect(json.dispute).toBeNull();
    expect(json.payment_intent).toBe(intent.publicId);
    expect([json.gross, json.fee, json.net]).toEqual(['921', '0', '-921']);
    expect(json.exchange_rate).toBe(0.921);
    // The PROVIDER's refund id, never the `re_…`.
    expect(providerCalls).toEqual([`getRefundSettlement:re_stripe_${refund.publicId}`]);
  });

  test('expands the refund it describes', async () => {
    const intent = await chargedIntent();
    const refund = await refundOf(intent);

    const { status, json } = await get(
      `/v1/refunds/${refund.publicId}/settlement?expand[]=refund&expand[]=payment_intent`,
    );

    expect(status).toBe(200);
    expect(typeof json.refund === 'object' && json.refund?.object).toBe('refund');
    expect(typeof json.refund === 'object' && json.refund?.id).toBe(refund.publicId);
    expect(typeof json.payment_intent === 'object' && json.payment_intent.id).toBe(intent.publicId);
  });

  /** The provider never acknowledged it: there is no movement to read. */
  test('says unknown for a refund the provider never acknowledged', async () => {
    const intent = await chargedIntent();
    const refund = await refundOf(intent, false);

    const { status, json } = await get(`/v1/refunds/${refund.publicId}/settlement`);

    expect(status).toBe(200);
    expect(json.status).toBe('unknown');
    expect(json.net).toBeNull();
    expect(providerCalls).toHaveLength(0);
  });

  test("says unknown rather than failing when a refund's provider is unreachable", async () => {
    const intent = await chargedIntent();
    const refund = await refundOf(intent);
    getSettlementThrows = new Error('the acquirer could not be reached');

    const { status, json } = await get(`/v1/refunds/${refund.publicId}/settlement`);

    expect(status).toBe(200);
    expect(json.status).toBe('unknown');
    expect(json.gross).toBeNull();
  });

  test("does not report another merchant's refund", async () => {
    const other = await seedMerchant();
    const theirs = await seedIntent(other, { rail: 'card', currency: 'EUR' });
    const refund = await refundOf(theirs);

    const { status } = await get(`/v1/refunds/${refund.publicId}/settlement`);

    expect(status).toBe(404);
    expect(providerCalls).toHaveLength(0);
  });

  /** The withdrawal: the principal and the dispute fee, `net` negative. */
  test("reports a dispute's withdrawal, beside the payment it disputes", async () => {
    settlementResponse = {
      status: 'available',
      gross: '5000',
      fee: '1500',
      net: '-6500',
      currency: 'EUR',
      availableOn: new Date('2026-09-26T00:00:00.000Z'),
      exchangeRate: null,
    };
    const intent = await chargedIntent();
    const dispute = await disputeOf(intent);

    const { status, json } = await get(
      `/v1/disputes/${dispute.publicId}/settlement?expand[]=dispute`,
    );

    expect(status).toBe(200);
    expect(json.payment_intent).toBe(intent.publicId);
    expect(json.refund).toBeNull();
    expect(typeof json.dispute === 'object' && json.dispute?.id).toBe(dispute.publicId);
    expect([json.gross, json.fee, json.net]).toEqual(['5000', '1500', '-6500']);
    expect(providerCalls).toEqual([`getDisputeSettlement:${dispute.providerObjectId}`]);
  });

  /** An inquiry moves no money: every figure `null`, never `0`. */
  test('says unknown, not zero, for an inquiry', async () => {
    const intent = await chargedIntent();
    const dispute = await disputeOf(intent, true);

    const { status, json } = await get(`/v1/disputes/${dispute.publicId}/settlement`);

    expect(status).toBe(200);
    expect(json.dispute).toBe(dispute.publicId);
    expect(json.status).toBe('unknown');
    expect(json.gross).toBeNull();
    expect(json.fee).toBeNull();
    expect(json.net).toBeNull();
  });

  test("does not report another merchant's dispute", async () => {
    const other = await seedMerchant();
    const theirs = await seedIntent(other, { rail: 'card', currency: 'EUR' });
    const dispute = await disputeOf(theirs);

    const { status } = await get(`/v1/disputes/${dispute.publicId}/settlement`);

    expect(status).toBe(404);
    expect(providerCalls).toHaveLength(0);
  });
});
