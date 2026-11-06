/**
 * The end-to-end FairCoin TESTNET canary, gateway half (ADR 0002 "Still
 * required before mainnet", item 4; evidence in `docs/audits/2026-11-06-mainnet-gate/`).
 *
 * Real money movement on a real FairCoin chain, through the gateway's real code
 * against a real Postgres:
 *
 *  1. social path — `POST /v1/social/:username/next_address` reserves on the
 *     recipient's cursor; the payer pays it with `@peable.to/pay`;
 *  2. merchant path, fiat — a EUR Checkout Session for a merchant owned by that
 *     PERSON is confirmed with `payment_method_type: 'faircoin'` at the LIVE
 *     quote (Explorer + ECB), paid with `@peable.to/pay`, reported, watched by
 *     `SettlementWatcher` against the chain to `succeeded`, session `paid`;
 *  3. merchant path, organization — a FAIR Checkout Session for a merchant owned
 *     by an ORGANIZATION (oxy ADR 0061) the same way, on the organization's cursor.
 *
 * The wallet half (`packages/frontend/src/wallet/__canary__/`) then derives the
 * watch window from the cursor this half reads back, finds every coin, and
 * spends them with the identity key's holder.
 *
 * Skipped unless `CANARY_NODE_CONF` (a private testnet node's faircoin.conf)
 * and `CANARY_EVIDENCE_OUT` are set, with `EXPLORER_BASE_URL` pointing at
 * `explorerShim.ts`. The DID read is the one stand-in: the recipients' public
 * keys come from `CANARY_PERSON_PUBLIC_KEY` / `CANARY_ORG_PUBLIC_KEY`, since
 * the canary's keys are not Oxy accounts.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { User } from '@oxy.so/core';
import { hexToBytes } from '@fairco.in/core';
import {
  KeyManager,
  sendPayment,
  type ChainAccess,
  type AddressInfo as PayAddressInfo,
} from '@peable.to/pay';
import { getNetwork } from '@fairco.in/core';
import { oxy as realOxy } from '../../oxy';
import { overrideOxy } from '../helpers/oxyOverrides';
import { must } from '../helpers/must';
import { requestIdMiddleware } from '../../lib/requestId';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  seedMerchant,
  seedPrice,
  useGatewayDatabase,
} from '../helpers/gatewayTestDatabase';
import { useIdentityKeyResolver } from '../../services/socialReceive';
import { liveQuoteSources, useQuoteSources } from '../../services/faircoin/quote';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
import { reportFaircoinBroadcast } from '../../services/faircoinBroadcast';
import { SettlementWatcher } from '../../services/settlementWatcher';
import { getTransaction } from '../../services/explorer';
import { createCheckoutSessionsRouter } from '../../routes/checkoutSessions';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { mine, nodeFromConf, type FaircoinNode } from './faircoinNode';

const CONF = process.env.CANARY_NODE_CONF;
const OUT = process.env.CANARY_EVIDENCE_OUT;
const PERSON_KEY = process.env.CANARY_PERSON_PUBLIC_KEY;
const ORG_KEY = process.env.CANARY_ORG_PUBLIC_KEY;
const ENABLED = Boolean(CONF && OUT && PERSON_KEY && ORG_KEY) && POSTGRES_TESTS_ENABLED;

const PERSON = 'canary_person_0001';
const PERSON_USERNAME = 'canaryperson';
const ORG = 'canary_org_0001';
const SENDER = 'canary_sender_0001';
const NETWORK = 'testnet' as const;

// The social route resolves `@username` through Oxy; the canary's recipient is
// not an Oxy account, so only that one read is answered here.
// Only when the canary runs: `mock.module` is process-wide in bun.
if (ENABLED) {
  mock.module('../../oxy', () => ({
    oxy: overrideOxy(realOxy, {
      users: {
        byUsername: async (username: string) => {
          if (username !== PERSON_USERNAME) {
            throw Object.assign(new Error('not found'), { status: 404 });
          }
          return { id: PERSON, username } as unknown as User;
        },
      },
    }),
  }));
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read structurally
type Json = Record<string, any>;

let node: FaircoinNode;
let server: Server;
let baseUrl = '';
let personMerchant: MerchantRow;
let orgMerchant: MerchantRow;
let actingUser = SENDER;
const evidence: Json = { network: NETWORK, started_at: new Date().toISOString(), steps: [] };

function step(name: string, details: Json): void {
  evidence.steps.push({ name, at: new Date().toISOString(), ...details });
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** `@peable.to/pay`'s chain access, over the node (what the Explorer serves). */
function chainAccess(): ChainAccess {
  return {
    async fetchAddressInfo(addresses) {
      const result = new Map<string, PayAddressInfo>();
      for (const address of addresses) {
        const query = { addresses: [address] };
        const utxos = await node.call<
          { txid: string; outputIndex: number; script: string; satoshis: number; height: number }[]
        >('getaddressutxos', [query]);
        const txids = await node.call<string[]>('getaddresstxids', [query]);
        result.set(address, {
          txCount: txids.length,
          utxos: utxos.map((u) => ({
            txid: u.txid,
            vout: u.outputIndex,
            address,
            value: BigInt(u.satoshis),
            scriptPubKey: hexToBytes(u.script),
            blockHeight: u.height,
            confirmed: u.height > 0,
          })),
        });
      }
      return result;
    },
    fetchFeePerByte: async () => 10,
    fetchChainTip: async () => node.call<number>('getblockcount'),
    broadcastTransaction: async (hex) => node.call<string>('sendrawtransaction', [hex]),
  };
}

/** A fresh payer wallet, funded from the node and confirmed. */
async function fundedPayer(fair: number): Promise<Uint8Array> {
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const km = KeyManager.fromSeed(seed, getNetwork(NETWORK));
  const address = km.getNextAddress().address;
  km.wipe();
  const txid = await node.call<string>('sendtoaddress', [address, fair]);
  await mine(node, 1);
  step('fund payer', { address, txid, fair });
  return seed;
}

async function pay(seed: Uint8Array, to: string, amountSat: bigint): Promise<string> {
  const { txid, feeSat } = await sendPayment(
    { seed, network: NETWORK, to, amountSat, feePerByte: 10 },
    chainAccess(),
  );
  step('payer broadcast', {
    to,
    amount_sat: amountSat.toString(),
    txid,
    fee_sat: feeSat.toString(),
  });
  return txid;
}

const stubRequireMerchant =
  (merchant: () => MerchantRow): RequestHandler =>
  (req, _res, next) => {
    (req as OxyAuthRequest).serviceApp = {
      appId: merchant().oxyAppId,
      appName: 'canary',
      scopes: ['payments:read', 'payments:write'],
      credentialId: 'canary',
      ownerAccountId: must(merchant().ownerAccountId),
      environment: 'development',
      tier: 'external',
    };
    next();
  };

let currentMerchant: MerchantRow;
const passthrough: RequestHandler = (_req, _res, next) => next();
const requireUser: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).userId = actingUser;
  next();
};

if (ENABLED) useGatewayDatabase();

beforeAll(async () => {
  if (!ENABLED) return;
  node = nodeFromConf(must(CONF));
  const keys: Record<string, Uint8Array> = {
    [PERSON]: hexToBytes(must(PERSON_KEY)),
    [ORG]: hexToBytes(must(ORG_KEY)),
  };
  useIdentityKeyResolver(async (accountId) => keys[accountId] ?? null);
  // The LIVE quote: the Explorer's FAIR/USD (through the shim, unaltered) and the ECB.
  useQuoteSources(liveQuoteSources());

  personMerchant = await seedMerchant({
    ownerAccountId: PERSON,
    network: NETWORK,
    requiredConfirmations: 2,
  });
  orgMerchant = await seedMerchant({
    ownerAccountId: ORG,
    network: NETWORK,
    requiredConfirmations: 2,
  });
  currentMerchant = personMerchant;

  const { createSocialRouter } = await import('../../routes/social');
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(createSocialRouter({ requireOxyUser: requireUser }));
  app.use(
    createCheckoutSessionsRouter({
      requireMerchant: stubRequireMerchant(() => currentMerchant),
      publicRateLimit: passthrough,
    }),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  step('start', { tip: await node.call<number>('getblockcount') });
});

afterAll(async () => {
  if (!ENABLED) return;
  evidence.finished_at = new Date().toISOString();
  writeFileSync(must(OUT), `${JSON.stringify(evidence, null, 2)}\n`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Confirm a session with FairCoin, pay it, report it, and watch the chain settle it. */
async function checkoutPaidOnChain(
  merchant: MerchantRow,
  price: { currency: 'EUR' | 'FAIR'; unitAmount: string },
  payerSeed: Uint8Array,
  label: string,
): Promise<{ address: string; txid: string; amount: string }> {
  currentMerchant = merchant;
  const seeded = await seedPrice(merchant, price);
  const created = await call('POST', '/v1/checkout_sessions', {
    success_url: 'https://canary.example/thanks',
    line_items: [{ price: seeded.publicId, quantity: 1 }],
    payment_method_types: ['faircoin'],
  });
  expect(created.status).toBe(201);
  const session = created.body;
  const secret = decodeURIComponent(String(session.url).split('#cs=')[1] ?? '');
  const payerHeaders = { 'X-Peable-Client-Secret': secret };
  const details = await call(
    'POST',
    `/v1/checkout_sessions/${session.id}/public`,
    { customer_details: { email: 'payer@canary.example' } },
    payerHeaders,
  );
  expect(details.status).toBe(200);
  const confirmed = await call(
    'POST',
    `/v1/checkout_sessions/${session.id}/public/confirm`,
    { payment_method_type: 'faircoin' },
    payerHeaders,
  );
  if (confirmed.status !== 200) throw new Error(`confirm: ${JSON.stringify(confirmed.body)}`);
  const intent = confirmed.body.payment_intent;
  expect(intent.status).toBe('requires_action');
  const address = intent.next_action.faircoin_payment.address as string;
  const row = must(await findIntentByPublicId(gatewayDb(), intent.id));
  expect(row.faircoinRecipientAccountId).toBe(merchant.ownerAccountId);
  step(`${label}: confirmed`, {
    session: session.id,
    payment_intent: intent.id,
    order: `${session.amount_total} ${session.currency}`,
    amount_fair_base_units: intent.amount,
    quote: row.faircoinQuote ?? null,
    address,
    recipient_account: row.faircoinRecipientAccountId,
  });

  const txid = await pay(payerSeed, address, BigInt(intent.amount));
  const reported = await reportFaircoinBroadcast(row, txid);
  expect(reported.kind).toBe('updated');

  const watcher = new SettlementWatcher({ getTransaction, onChange: () => {} });
  await watcher.check();
  expect(must(await findIntentByPublicId(gatewayDb(), intent.id)).status).toBe('processing');
  const tip = await mine(node, 2);
  await watcher.check();
  const settled = must(await findIntentByPublicId(gatewayDb(), intent.id));
  expect(settled.status).toBe('succeeded');
  const paid = await call('GET', `/v1/checkout_sessions/${session.id}`);
  expect(paid.body.status).toBe('complete');
  expect(paid.body.payment_status).toBe('paid');
  step(`${label}: settled by the watcher`, {
    payment_intent: intent.id,
    status: settled.status,
    confirmations: settled.confirmations,
    tip,
    session_status: paid.body.status,
    payment_status: paid.body.payment_status,
  });
  return { address, txid, amount: intent.amount };
}

test.skipIf(!ENABLED)(
  'social, fiat merchant and organization merchant payments settle on testnet',
  async () => {
    const payer = await fundedPayer(1000);

    // 1. Social: the sender reserves on the person's cursor and pays it.
    actingUser = SENDER;
    const reserved = await call('POST', `/v1/social/${PERSON_USERNAME}/next_address`, {
      network: NETWORK,
    });
    expect(reserved.status).toBe(200);
    step('social: reserved', { address: reserved.body.address, index: reserved.body.index });
    const socialTxid = await pay(payer, reserved.body.address, 2_500_000_000n);
    await mine(node, 1);

    // 2. A EUR order for the merchant the person owns: the same cursor.
    const fiat = await checkoutPaidOnChain(
      personMerchant,
      { currency: 'EUR', unitAmount: '1250' },
      payer,
      'merchant (EUR, person-owned)',
    );

    // 3. A FAIR order for the merchant an organization owns: the organization's cursor.
    const org = await checkoutPaidOnChain(
      orgMerchant,
      { currency: 'FAIR', unitAmount: '1500000000' },
      payer,
      'merchant (FAIR, organization-owned)',
    );

    // What each recipient's wallet syncs from: its own cursor, and the key it records.
    actingUser = PERSON;
    const personCursor = await call('GET', `/v1/social/me/cursor?network=${NETWORK}`);
    actingUser = ORG;
    const orgCursor = await call('GET', `/v1/social/me/cursor?network=${NETWORK}`);
    expect(personCursor.body.reserved_through).toBe(2);
    expect(orgCursor.body.reserved_through).toBe(1);
    evidence.wallets = {
      person: {
        account: PERSON,
        cursor: personCursor.body,
        received: [
          { address: reserved.body.address, txid: socialTxid, amount: '2500000000' },
          { address: fiat.address, txid: fiat.txid, amount: fiat.amount },
        ],
      },
      organization: {
        account: ORG,
        cursor: orgCursor.body,
        received: [{ address: org.address, txid: org.txid, amount: org.amount }],
      },
    };
  },
  600_000,
);
