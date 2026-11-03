/**
 * Events and their deliveries, end to end, against a real server (ADR 0014 D4,
 * ADR 0001 D7).
 *
 * The properties here are the ones an inline delivery could not have: an event
 * is stored in the commit of its change (and not without it), it fans out to
 * exactly the endpoints that asked for it, a merchant endpoint that is down
 * does not lose it, a dispatcher that dies mid-attempt does not strand it, two
 * dispatchers do not deliver it twice, and an endpoint failing for three days
 * is disabled. None of them is expressible against a mocked database.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { must } from '../../__tests__/helpers/must';
import { eq } from 'drizzle-orm';
import type { SafeFetchResult } from '@oxy.so/core/server';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { verifyWebhook } from '@peable.to/shared-types';
import { events, webhookDeliveries, webhookEndpoints } from '../../db/schema';
import { findDeliveryForMerchant } from '../../db/webhooks/webhookDeliveryRepository';
import {
  findEndpointForMerchant,
  rollEndpointSecret,
  updateEndpoint,
} from '../../db/webhooks/webhookEndpointRepository';
import { claimDueDeliveries } from '../../db/webhooks/webhookOutboxRepository';
import type { SafeFetchFn } from '../webhookDispatcher';
import {
  nextAttemptDelayMs,
  runWebhookOutboxPass,
  WEBHOOK_RETRY_SCHEDULE_MS,
} from '../webhookOutbox';
import { transitionIntent } from '../intentTransition';
import { recordEvent } from '../events';
import { toPaymentIntentDTO } from '../../lib/serialize';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedDelivery,
  seedIntent,
  seedMerchant,
  seedWebhookEndpoint,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

useGatewayDatabase();

const HOOK_URL = 'https://merchant.example/hook';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A `SafeFetchResult` backed by a real `IncomingMessage`, so no cast is needed. */
function fakeResult(status: number): SafeFetchResult {
  const response = new IncomingMessage(new Socket());
  response.destroy = () => response;
  return { response, status, headers: {}, finalUrl: HOOK_URL };
}

interface Sent {
  readonly url: string;
  readonly body: string;
  readonly signature: string;
}

function respondWith(status: number): { fetch: SafeFetchFn; calls: () => number; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    fetch: async (url, options) => {
      sent.push({
        url,
        body: typeof options?.body === 'string' ? options.body : '',
        signature: options?.headers?.['Peable-Signature'] ?? '',
      });
      return fakeResult(status);
    },
    calls: () => sent.length,
    sent,
  };
}

/** The lease column, which no ordinary read selects. */
async function leaseOwnerOf(id: string): Promise<string | null> {
  const [row] = await gatewayDb()
    .select({ leaseOwner: webhookDeliveries.leaseOwner })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, id));
  return row?.leaseOwner ?? null;
}

async function pendingDelivery() {
  const merchant = await seedMerchant();
  const { endpoint, secret } = await seedWebhookEndpoint(merchant, { url: HOOK_URL });
  const intent = await seedIntent(merchant);
  const delivery = await seedDelivery(merchant, intent, { endpoint, pending: true });
  return { merchant, endpoint, secret, intent, delivery };
}

async function eventsOf(intentId: string) {
  return gatewayDb()
    .select({ id: events.id, type: events.type })
    .from(events)
    .where(eq(events.paymentIntentId, intentId));
}

async function deliveriesOf(eventId: string) {
  return gatewayDb()
    .select({ endpointId: webhookDeliveries.endpointId })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.eventId, eventId));
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('events', () => {
  beforeEach(async () => {
    await resetGatewayTables();
  });

  /** ADR 0001 D7: the state change and the event commit together. */
  test('a transition stores its event in the same commit, with previous_attributes', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant);

    const moved = await transitionIntent(intent.id, { from: intent.status, status: 'canceled' });

    expect(moved.kind === 'updated' && moved.row.status).toBe('canceled');
    const stored = await gatewayDb()
      .select()
      .from(events)
      .where(eq(events.paymentIntentId, intent.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.type).toBe('payment_intent.canceled');
    expect(stored[0]?.previousAttributes).toEqual({ status: intent.status });
    expect(stored[0]?.apiVersion).toBe('2026-11-03');
    // No request context: a background change records `request: null`.
    expect(stored[0]?.requestId).toBeNull();
  });

  /** And not without it: a rolled-back change leaves no event and no delivery. */
  test('a rolled-back change leaves no event behind', async () => {
    const merchant = await seedMerchant({ webhookUrl: HOOK_URL });
    const intent = await seedIntent(merchant);

    await expect(
      gatewayDb().transaction(async (tx) => {
        await recordEvent(tx, {
          merchantId: merchant.id,
          type: 'payment_intent.succeeded',
          object: toPaymentIntentDTO(intent),
          paymentIntentId: intent.id,
        });
        throw new Error('the change failed after its event was written');
      }),
    ).rejects.toThrow('the change failed');

    expect(await gatewayDb().select().from(events)).toHaveLength(0);
    expect(await gatewayDb().select().from(webhookDeliveries)).toHaveLength(0);
  });

  /** The record exists whether or not anyone is listening. */
  test('a merchant with no endpoint still gets the event, and no delivery', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant);

    await transitionIntent(intent.id, { from: intent.status, status: 'canceled' });

    const [event] = await eventsOf(intent.id);
    expect(event).toBeDefined();
    expect(await deliveriesOf(must(event).id)).toHaveLength(0);
  });

  test('an event fans out to every enabled endpoint whose enabled_events match', async () => {
    const merchant = await seedMerchant();
    const all = await seedWebhookEndpoint(merchant, { enabledEvents: ['*'] });
    const exact = await seedWebhookEndpoint(merchant, {
      enabledEvents: ['payment_intent.canceled', 'payment_intent.succeeded'],
    });
    const other = await seedWebhookEndpoint(merchant, {
      enabledEvents: ['payment_intent.succeeded'],
    });
    const disabled = await seedWebhookEndpoint(merchant, { enabledEvents: ['*'] });
    await updateEndpoint(gatewayDb(), disabled.endpoint.publicId, merchant.id, { disabled: true });
    // Another merchant's endpoint never receives this merchant's event.
    const stranger = await seedMerchant();
    await seedWebhookEndpoint(stranger, { enabledEvents: ['*'] });
    const intent = await seedIntent(merchant);

    await transitionIntent(intent.id, { from: intent.status, status: 'canceled' });

    const [event] = await eventsOf(intent.id);
    const reached = (await deliveriesOf(must(event).id)).map((row) => row.endpointId).sort();
    expect(reached).toEqual([all.endpoint.id, exact.endpoint.id].sort());
    expect(reached).not.toContain(other.endpoint.id);
    expect(reached).not.toContain(disabled.endpoint.id);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the webhook outbox', () => {
  beforeEach(async () => {
    await resetGatewayTables();
  });

  test('a 2xx settles the delivery, sending the stored event signed with the endpoint secret', async () => {
    const { merchant, secret, delivery } = await pendingDelivery();
    const ok = respondWith(200);

    const result = await runWebhookOutboxPass({ safeFetch: ok.fetch });

    expect(result).toMatchObject({ claimed: 1, delivered: 1 });
    const row = await findDeliveryForMerchant(gatewayDb(), delivery.id, merchant.id);
    expect(row?.lastStatus).toBe('delivered');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toBeNull();
    expect(await leaseOwnerOf(delivery.id)).toBeNull();

    const sent = must(ok.sent[0]);
    const body = JSON.parse(sent.body);
    expect(body).toMatchObject({
      id: delivery.eventPublicId,
      object: 'event',
      type: 'payment_intent.succeeded',
      api_version: '2026-11-03',
      livemode: false,
      request: { id: null, idempotency_key: null },
    });
    expect(Object.keys(body)).toEqual([
      'id',
      'object',
      'type',
      'created',
      'livemode',
      'api_version',
      'data',
      'request',
    ]);
    const now = Math.floor(Date.now() / 1000);
    expect(verifyWebhook(secret, sent.body, sent.signature, 300, now)).toBe(true);
  });

  /**
   * A rolled secret keeps signing beside the new one inside its window — two
   * `v1=` — and stops once the window has passed.
   */
  test('a rolled secret signs beside the new one until it expires', async () => {
    const { merchant, endpoint, secret: oldSecret, intent } = await pendingDelivery();
    await rollEndpointSecret(gatewayDb(), endpoint.publicId, merchant.id, {
      secret: 'whsec_rolled_new_secret_value',
      previousExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const ok = respondWith(200);
    await runWebhookOutboxPass({ safeFetch: ok.fetch });
    const sent = must(ok.sent[0]);
    const now = Math.floor(Date.now() / 1000);
    expect(sent.signature.split(',').filter((part) => part.startsWith('v1='))).toHaveLength(2);
    expect(verifyWebhook(oldSecret, sent.body, sent.signature, 300, now)).toBe(true);
    expect(
      verifyWebhook('whsec_rolled_new_secret_value', sent.body, sent.signature, 300, now),
    ).toBe(true);

    // A roll with no overlap drops the previous secret at once.
    await rollEndpointSecret(gatewayDb(), endpoint.publicId, merchant.id, {
      secret: 'whsec_rolled_again_secret_value',
      previousExpiresAt: null,
    });
    await seedDelivery(merchant, intent, { endpoint, pending: true });
    const again = respondWith(200);
    await runWebhookOutboxPass({ safeFetch: again.fetch });
    const second = must(again.sent[0]);
    expect(second.signature.split(',').filter((part) => part.startsWith('v1='))).toHaveLength(1);
    expect(
      verifyWebhook('whsec_rolled_new_secret_value', second.body, second.signature, 300, now),
    ).toBe(false);
  });

  /** A retry reaches where the endpoint IS, not where it was at enqueue. */
  test('a retry is sent to the endpoint URL as it is now', async () => {
    const { merchant, endpoint, delivery } = await pendingDelivery();
    await runWebhookOutboxPass({ safeFetch: respondWith(503).fetch });
    await updateEndpoint(gatewayDb(), endpoint.publicId, merchant.id, {
      url: 'https://moved.example/hook',
    });
    const ok = respondWith(200);
    await runWebhookOutboxPass({ safeFetch: ok.fetch, now: new Date(Date.now() + 5 * 60_000) });
    expect(must(ok.sent[0]).url).toBe('https://moved.example/hook');
    const row = await findDeliveryForMerchant(gatewayDb(), delivery.id, merchant.id);
    expect(row?.url).toBe('https://moved.example/hook');
  });

  test('a failing endpoint leaves the event queued rather than losing it', async () => {
    const { merchant, delivery } = await pendingDelivery();

    const down = respondWith(503);
    const result = await runWebhookOutboxPass({ safeFetch: down.fetch });

    expect(result).toMatchObject({ claimed: 1, delivered: 0, retrying: 1 });
    const row = await findDeliveryForMerchant(gatewayDb(), delivery.id, merchant.id);
    expect(row?.lastStatus).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).not.toBeNull();
    expect(row?.lastError).toContain('503');
    expect(await leaseOwnerOf(delivery.id)).toBeNull();

    const recovered = respondWith(200);
    await runWebhookOutboxPass({
      safeFetch: recovered.fetch,
      now: new Date(Date.now() + 5 * 60_000),
    });
    const settled = await findDeliveryForMerchant(gatewayDb(), delivery.id, merchant.id);
    expect(settled?.lastStatus).toBe('delivered');
    expect(settled?.attempts).toBe(2);
  });

  test('a 4xx is terminal — no retry is scheduled for a payload the target refuses', async () => {
    const { merchant, delivery } = await pendingDelivery();

    const result = await runWebhookOutboxPass({ safeFetch: respondWith(422).fetch });

    expect(result).toMatchObject({ claimed: 1, terminal: 1 });
    const row = await findDeliveryForMerchant(gatewayDb(), delivery.id, merchant.id);
    expect(row?.lastStatus).toBe('failed');
    expect(row?.nextAttemptAt).toBeNull();
  });

  test('a row scheduled for the future is not claimed', async () => {
    const { merchant, delivery } = await pendingDelivery();
    await runWebhookOutboxPass({ safeFetch: respondWith(503).fetch });

    const second = respondWith(200);
    const result = await runWebhookOutboxPass({ safeFetch: second.fetch });

    expect(result.claimed).toBe(0);
    expect(second.calls()).toBe(0);
    const row = await findDeliveryForMerchant(gatewayDb(), delivery.id, merchant.id);
    expect(row?.lastStatus).toBe('pending');
  });

  /**
   * Sequential: excluded by the LIVE-LEASE predicate, not by `SKIP LOCKED` —
   * the first update has committed by then. The concurrent case is below.
   */
  test('a leased row is not handed to a later dispatcher', async () => {
    await pendingDelivery();

    const first = await claimDueDeliveries(gatewayDb(), {
      limit: 10,
      leaseOwner: 'dispatcher-a',
      leaseMs: 60_000,
    });
    const second = await claimDueDeliveries(gatewayDb(), {
      limit: 10,
      leaseOwner: 'dispatcher-b',
      leaseMs: 60_000,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test('an expired lease makes the row claimable again', async () => {
    await pendingDelivery();

    await claimDueDeliveries(gatewayDb(), {
      limit: 10,
      leaseOwner: 'dispatcher-that-died',
      leaseMs: 1_000,
    });

    const stillHeld = await claimDueDeliveries(gatewayDb(), {
      limit: 10,
      leaseOwner: 'dispatcher-b',
      leaseMs: 60_000,
    });
    expect(stillHeld).toHaveLength(0);

    const afterExpiry = await claimDueDeliveries(gatewayDb(), {
      limit: 10,
      leaseOwner: 'dispatcher-b',
      leaseMs: 60_000,
      now: new Date(Date.now() + 5_000),
    });
    expect(afterExpiry).toHaveLength(1);
  });

  /**
   * Two dispatchers claiming AT THE SAME TIME still produce one delivery. What
   * this does NOT prove is `SKIP LOCKED` — see the note on `claimDueDeliveries`.
   */
  test('two dispatchers claiming concurrently share the row out exactly once', async () => {
    await pendingDelivery();

    const db = gatewayDb();
    let releaseFirst: () => void = () => undefined;
    const firstHasClaimed = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const a = db.transaction(async (tx) => {
      const claimed = await claimDueDeliveries(tx, {
        limit: 10,
        leaseOwner: 'dispatcher-a',
        leaseMs: 60_000,
      });
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return claimed;
    });

    const b = firstHasClaimed.then(() =>
      db.transaction(async (tx) =>
        claimDueDeliveries(tx, {
          limit: 10,
          leaseOwner: 'dispatcher-b',
          leaseMs: 60_000,
        }),
      ),
    );

    const [claimedByA, claimedByB] = await Promise.all([a, b]);

    expect(claimedByA.length + claimedByB.length).toBe(1);
  });

  /** Disabled after enqueue: released as `failed` without an attempt or a request. */
  test('a delivery to an endpoint disabled since it was enqueued ends without an attempt', async () => {
    const { merchant, endpoint, delivery } = await pendingDelivery();
    await updateEndpoint(gatewayDb(), endpoint.publicId, merchant.id, { disabled: true });

    const never = respondWith(200);
    const result = await runWebhookOutboxPass({ safeFetch: never.fetch });

    expect(result).toMatchObject({ claimed: 1, terminal: 1 });
    expect(never.calls()).toBe(0);
    const row = await findDeliveryForMerchant(gatewayDb(), delivery.id, merchant.id);
    expect(row?.lastStatus).toBe('failed');
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBe('webhook endpoint is disabled');
  });

  /** Deleting an endpoint takes its deliveries — pending ones included. */
  test('deleting an endpoint deletes its deliveries', async () => {
    const { merchant, endpoint, delivery } = await pendingDelivery();
    await gatewayDb().delete(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(await findDeliveryForMerchant(gatewayDb(), delivery.id, merchant.id)).toBeNull();
    expect((await runWebhookOutboxPass({ safeFetch: respondWith(200).fetch })).claimed).toBe(0);
  });

  /**
   * Three days of nothing but failures disables the endpoint, with a reason
   * the merchant can see; one success in between resets the clock.
   */
  test('an endpoint failing for three days straight is disabled automatically', async () => {
    const { merchant, endpoint, intent } = await pendingDelivery();
    const start = Date.now();

    await runWebhookOutboxPass({ safeFetch: respondWith(503).fetch, now: new Date(start) });
    let current = must(await findEndpointForMerchant(gatewayDb(), endpoint.publicId, merchant.id));
    expect(current.status).toBe('enabled');
    expect(current.failingSince?.getTime()).toBe(start);

    // A success two days in clears the run…
    await seedDelivery(merchant, intent, { endpoint, pending: true });
    await runWebhookOutboxPass({
      safeFetch: respondWith(200).fetch,
      now: new Date(start + 2 * DAY_MS),
    });
    current = must(await findEndpointForMerchant(gatewayDb(), endpoint.publicId, merchant.id));
    expect(current.failingSince).toBeNull();

    // …so the next failure starts a new one, and only three days of it disable.
    await seedDelivery(merchant, intent, { endpoint, pending: true });
    await runWebhookOutboxPass({
      safeFetch: respondWith(500).fetch,
      now: new Date(start + 2 * DAY_MS + 1_000),
    });
    current = must(await findEndpointForMerchant(gatewayDb(), endpoint.publicId, merchant.id));
    expect(current.status).toBe('enabled');

    await seedDelivery(merchant, intent, { endpoint, pending: true });
    await runWebhookOutboxPass({
      safeFetch: respondWith(410).fetch,
      now: new Date(start + 5 * DAY_MS + 2_000),
    });
    current = must(await findEndpointForMerchant(gatewayDb(), endpoint.publicId, merchant.id));
    expect(current.status).toBe('disabled');
    expect(current.disabledReason).toBe('delivery_failures');

    // Re-enabling starts the clock again.
    const enabled = await updateEndpoint(gatewayDb(), endpoint.publicId, merchant.id, {
      disabled: false,
    });
    expect(enabled !== 'missing' && enabled !== 'limit_exceeded' && enabled.status).toBe('enabled');
    current = must(await findEndpointForMerchant(gatewayDb(), endpoint.publicId, merchant.id));
    expect(current.failingSince).toBeNull();
    expect(current.disabledReason).toBeNull();
  });
});

describe('the backoff schedule', () => {
  test('grows, spans about three days, and ends', () => {
    const mid = () => 0.5;
    expect(nextAttemptDelayMs(1, mid)).toBe(60_000);
    expect(nextAttemptDelayMs(2, mid)).toBe(5 * 60_000);
    expect(nextAttemptDelayMs(6, mid)).toBeGreaterThan(must(nextAttemptDelayMs(5, mid)));
    const total = WEBHOOK_RETRY_SCHEDULE_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThan(2.9 * DAY_MS);
    expect(total).toBeLessThanOrEqual(3 * DAY_MS);
    // Past the end of the schedule the budget is spent — what makes a row `dead`.
    expect(nextAttemptDelayMs(WEBHOOK_RETRY_SCHEDULE_MS.length + 1, mid)).toBeNull();
    expect(nextAttemptDelayMs(99, mid)).toBeNull();
  });

  test('jitters within ±20% and never goes negative', () => {
    expect(nextAttemptDelayMs(1, () => 0)).toBe(48_000);
    expect(nextAttemptDelayMs(1, () => 1)).toBe(72_000);
    expect(nextAttemptDelayMs(1, () => 0.5)).toBe(60_000);
  });
});
