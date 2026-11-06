/**
 * A FairCoin address is bound to the identity key it was derived from (ADR
 * 0002, amended 2026-11-06), over HTTP through the real gateway and database,
 * with only the Oxy credential stubbed and the recipient's `#key-1` swapped to
 * simulate a rotation (or an organization replacing its key):
 *
 * - every reservation records the key, on the intent and on its output;
 * - a payment still waiting for the payer under a replaced key is never offered
 *   again — a payer read of the session (or of the intent) retires it
 *   `recipient_key_changed`, the session stays open, and the next confirm
 *   reserves a fresh address from the NEW key;
 * - the periodic sweep retires what no payer read saw;
 * - a payment already broadcast under a replaced key is not canceled but
 *   stamped, and `succeeded` carries the stamp; the settlement waits when Oxy
 *   cannot be asked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { deriveSocialReceiveAddress, getNetwork } from '@fairco.in/core';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { createGateway, type Gateway } from '../../server';
import { must } from '../../__tests__/helpers/must';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedMerchant,
  storedEvents,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { testIdentityPublicKey } from '../../__tests__/setup/identityKeys';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
import { paymentIntentOutputs, socialReceiveCursors } from '../../db/schema';
import { useIdentityKeyResolver } from '../../services/socialReceive';
import {
  forgetRecentIdentityKeys,
  resetRecipientKeySweep,
  runRecipientKeySweep,
} from '../../services/faircoin/keyBinding';
import { reportFaircoinBroadcast } from '../../services/faircoinBroadcast';
import { applyChainObservation } from '../../services/settlementWatcher';
import { useAddressUsageReader } from '../../services/faircoin/addressPool';

type Json = Record<string, unknown>;

const APP_ID = 'app_key_binding';
let gateway: Gateway | undefined;
let baseUrl = '';

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 'key binding',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner_key_binding',
    environment: 'development',
    tier: 'external',
  };
  next();
};

/** The accounts whose `#key-1` has been replaced, and Oxy being unreachable. */
const rotated = new Set<string>();
let oxyDown = false;

function keyOf(accountId: string): Uint8Array {
  return testIdentityPublicKey(rotated.has(accountId) ? `${accountId}:rotated` : accountId);
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function rotate(accountId: string): void {
  rotated.add(accountId);
  // A payer read may reuse a key read a few seconds old; the rotation is now.
  forgetRecentIdentityKeys();
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

/** A FAIR checkout session its payer has filled in, and the payer's secret header. */
async function openSession(): Promise<{ id: string; secret: Record<string, string> }> {
  const session = await call('POST', '/v1/checkout_sessions', {
    line_items: [
      {
        price_data: { currency: 'FAIR', unit_amount: '100000000', product_data: { name: 'Item' } },
        quantity: 1,
      },
    ],
    success_url: 'https://shop.example/ok',
  });
  expect(session.status).toBe(201);
  const id = String(session.json.id);
  const secret = {
    'X-Peable-Client-Secret': decodeURIComponent(String(session.json.url).split('#cs=')[1] ?? ''),
  };
  const filled = await call(
    'POST',
    `/v1/checkout_sessions/${id}/public`,
    { customer_details: { email: 'p@example.com' } },
    secret,
  );
  expect(filled.status).toBe(200);
  return { id, secret };
}

async function confirm(id: string, secret: Record<string, string>): Promise<Json> {
  const confirmed = await call('POST', `/v1/checkout_sessions/${id}/public/confirm`, {}, secret);
  expect(confirmed.status).toBe(200);
  return confirmed.json;
}

const intentOf = (session: Json) => must(session.payment_intent as Json | null);

async function createApiIntent(): Promise<Json> {
  const created = await call('POST', '/v1/payment_intents', {
    amount: '100000000',
    network: 'testnet',
  });
  expect(created.status).toBe(201);
  return created.json;
}

useGatewayDatabase();

let previousResolver: ReturnType<typeof useIdentityKeyResolver> = null;

beforeAll(() => {
  previousResolver = useIdentityKeyResolver(async (accountId) => {
    if (oxyDown) throw new Error('oxy is unreachable');
    return accountId.startsWith('keyless_') ? null : keyOf(accountId);
  });
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    // A request carrying a client secret is the PAYER's: no merchant credential.
    optionalServiceAuth: (req, res, next) =>
      req.query.client_secret === undefined ? stubRequireMerchant(req, res, next) : next(),
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  useIdentityKeyResolver(previousResolver);
  gateway?.io.close();
  gateway?.httpServer.close();
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('a FairCoin address is bound to its key', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    rotated.clear();
    oxyDown = false;
    forgetRecentIdentityKeys();
    resetRecipientKeySweep();
    await seedMerchant({ oxyAppId: APP_ID, ownerAccountId: 'owner_key_binding' });
  });

  test('every reservation records the key it derived from, on the intent and its output', async () => {
    const created = await createApiIntent();
    const row = must(await findIntentByPublicId(gatewayDb(), String(created.id)));
    const recipient = must(row.faircoinRecipientAccountId);
    expect(row.faircoinIdentityPublicKey).toBe(hex(keyOf(recipient)));
    const [output] = await gatewayDb()
      .select()
      .from(paymentIntentOutputs)
      .where(eq(paymentIntentOutputs.paymentIntentId, row.id));
    expect(must(output).identityPublicKey).toBe(hex(keyOf(recipient)));
    expect((created.faircoin as Json).recipient_key_replaced_at).toBeNull();
  });

  test('rotation between reserve and pay: the session read retires the payment, the session stays open, and the next confirm derives from the new key', async () => {
    const { id, secret } = await openSession();
    const first = intentOf(await confirm(id, secret));
    const firstRow = must(await findIntentByPublicId(gatewayDb(), String(first.id)));
    const recipient = must(firstRow.faircoinRecipientAccountId);

    rotate(recipient);

    // The payer's next look at the order: the old address is gone.
    const read = await call('GET', `/v1/checkout_sessions/${id}/public`, undefined, secret);
    expect(read.status).toBe(200);
    expect(read.json.status).toBe('open');
    expect(read.json.payment_intent).toBeNull();

    const retired = must(await findIntentByPublicId(gatewayDb(), String(first.id)));
    expect(retired.status).toBe('canceled');
    expect(retired.cancellationReason).toBe('recipient_key_changed');
    const types = (await storedEvents({ paymentIntentId: retired.id })).map(({ row }) => row.type);
    expect(types.at(-1)).toBe('payment_intent.canceled');

    // A fresh reservation, from the NEW key, at the cursor's next index.
    const second = intentOf(await confirm(id, secret));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('requires_action');
    const secondRow = must(await findIntentByPublicId(gatewayDb(), String(second.id)));
    expect(secondRow.faircoinIdentityPublicKey).toBe(hex(keyOf(recipient)));
    expect(secondRow.faircoinIdentityPublicKey).not.toBe(firstRow.faircoinIdentityPublicKey);
    const [cursor] = await gatewayDb()
      .select()
      .from(socialReceiveCursors)
      .where(eq(socialReceiveCursors.oxyUserId, recipient));
    const index = must(cursor).nextDerivationIndex - 1;
    expect(secondRow.address).toBe(
      deriveSocialReceiveAddress(keyOf(recipient), index, getNetwork('testnet')),
    );
    expect(must(cursor).identityPublicKey).toBe(hex(keyOf(recipient)));

    // A retried confirm answers the SAME fresh payment.
    const again = intentOf(await confirm(id, secret));
    expect(again.id).toBe(second.id);
  });

  test('a confirm right after the rotation retires the stale payment and answers a fresh one', async () => {
    const { id, secret } = await openSession();
    const first = intentOf(await confirm(id, secret));
    rotate(
      must(
        must(await findIntentByPublicId(gatewayDb(), String(first.id))).faircoinRecipientAccountId,
      ),
    );

    const second = intentOf(await confirm(id, secret));
    expect(second.id).not.toBe(first.id);
    expect(must(await findIntentByPublicId(gatewayDb(), String(first.id))).cancellationReason).toBe(
      'recipient_key_changed',
    );
  });

  test("the intent's payer read retires it too", async () => {
    const created = await createApiIntent();
    rotate('owner_key_binding');
    const read = await call(
      'GET',
      `/v1/payment_intents/${String(created.id)}?client_secret=${encodeURIComponent(String(created.client_secret))}`,
    );
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({
      status: 'canceled',
      cancellation_reason: 'recipient_key_changed',
      next_action: null,
    });
  });

  test('an unchanged key leaves the payment alone, and so does an unreachable Oxy', async () => {
    const created = await createApiIntent();
    const secretQuery = `client_secret=${encodeURIComponent(String(created.client_secret))}`;
    const read = await call('GET', `/v1/payment_intents/${String(created.id)}?${secretQuery}`);
    expect(read.json.status).toBe('requires_action');

    rotate('owner_key_binding');
    oxyDown = true;
    const sweep = await runRecipientKeySweep();
    expect(sweep).toMatchObject({ examined: 1, retired: 0, unknown: 1 });
    expect(must(await findIntentByPublicId(gatewayDb(), String(created.id))).status).toBe(
      'requires_action',
    );
  });

  test('the sweep retires an open payment no payer has looked at since the rotation', async () => {
    const stale = await createApiIntent();
    rotate('owner_key_binding');
    const fresh = await createApiIntent();

    const sweep = await runRecipientKeySweep();
    expect(sweep).toMatchObject({ examined: 2, retired: 1, stamped: 0 });
    expect(must(await findIntentByPublicId(gatewayDb(), String(stale.id)))).toMatchObject({
      status: 'canceled',
      cancellationReason: 'recipient_key_changed',
    });
    expect(must(await findIntentByPublicId(gatewayDb(), String(fresh.id))).status).toBe(
      'requires_action',
    );
  });

  // Round-3 review: a payer who broadcast to the old key's address and has
  // not reported the txid yet must not be canceled under them.
  test('a replaced-key payment whose address the chain shows paid is not retired', async () => {
    const created = await createApiIntent();
    rotate('owner_key_binding');
    const previous = useAddressUsageReader(async () => 'used');
    try {
      const read = await call(
        'GET',
        `/v1/payment_intents/${String(created.id)}?client_secret=${encodeURIComponent(String(created.client_secret))}`,
      );
      expect(read.json.status).toBe('requires_action');
      expect(await runRecipientKeySweep()).toMatchObject({ retired: 0, held: 1 });
    } finally {
      useAddressUsageReader(previous);
    }
    // Testnet's node cannot tell (`unknown`, the preload's answer): there the
    // key change alone decides, as before.
    expect(await runRecipientKeySweep()).toMatchObject({ retired: 1, held: 0 });
  });

  test('broadcast under a replaced key: not canceled, stamped by the sweep, and succeeded says so', async () => {
    const created = await createApiIntent();
    const row = must(await findIntentByPublicId(gatewayDb(), String(created.id)));
    const broadcast = await reportFaircoinBroadcast(row, 'a'.repeat(64));
    expect(broadcast.kind).toBe('updated');
    rotate('owner_key_binding');

    const sweep = await runRecipientKeySweep();
    expect(sweep).toMatchObject({ retired: 0, stamped: 1 });
    const stamped = must(await findIntentByPublicId(gatewayDb(), String(created.id)));
    expect(stamped.status).toBe('processing');
    expect(stamped.faircoinRecipientKeyReplacedAt).toBeInstanceOf(Date);

    const settled = must(
      await applyChainObservation(stamped, {
        paid: true,
        confirmations: stamped.requiredConfirmations,
      }),
    );
    expect(settled.status).toBe('succeeded');
    const [event] = await storedEvents({
      paymentIntentId: row.id,
      type: 'payment_intent.succeeded',
    });
    const object = must(event).event.data.object as Json;
    const faircoin = object.faircoin as Json | null;
    expect(must(faircoin).recipient_key_replaced_at).toBeNumber();
  });

  test('the watcher reads the key fresh before succeeded: it stamps, and waits while Oxy cannot answer', async () => {
    const created = await createApiIntent();
    const row = must(await findIntentByPublicId(gatewayDb(), String(created.id)));
    expect((await reportFaircoinBroadcast(row, 'b'.repeat(64))).kind).toBe('updated');
    const processing = must(await findIntentByPublicId(gatewayDb(), String(created.id)));
    rotate('owner_key_binding');

    oxyDown = true;
    const deferred = await applyChainObservation(processing, {
      paid: true,
      confirmations: processing.requiredConfirmations,
    });
    expect(deferred).toBeNull();
    expect(must(await findIntentByPublicId(gatewayDb(), String(created.id))).status).toBe(
      'processing',
    );

    oxyDown = false;
    const settled = must(
      await applyChainObservation(processing, {
        paid: true,
        confirmations: processing.requiredConfirmations,
      }),
    );
    expect(settled.status).toBe('succeeded');
    expect(settled.faircoinRecipientKeyReplacedAt).toBeInstanceOf(Date);
  });

  test('a payment broadcast under its CURRENT key settles with no stamp', async () => {
    const created = await createApiIntent();
    const row = must(await findIntentByPublicId(gatewayDb(), String(created.id)));
    expect((await reportFaircoinBroadcast(row, 'c'.repeat(64))).kind).toBe('updated');
    const processing = must(await findIntentByPublicId(gatewayDb(), String(created.id)));
    const settled = must(
      await applyChainObservation(processing, {
        paid: true,
        confirmations: processing.requiredConfirmations,
      }),
    );
    expect(settled.status).toBe('succeeded');
    expect(settled.faircoinRecipientKeyReplacedAt).toBeNull();
  });
});
