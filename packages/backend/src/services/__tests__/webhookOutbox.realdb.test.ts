/**
 * The outbox, end to end, against a real server.
 *
 * The properties here are the ones the previous inline delivery could not have:
 * a merchant endpoint that is down does not lose the event, a dispatcher that
 * dies mid-attempt does not strand it, and two dispatchers do not deliver it
 * twice. None of them is expressible against a mocked database — `SKIP LOCKED`,
 * the schedule CHECK and the lease CHECK have no mocked counterpart.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { SafeFetchResult } from '@oxy.so/core/server';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { merchants, webhookDeliveries } from '../../db/schema';
import { findDeliveryForMerchant } from '../../db/webhooks/webhookDeliveryRepository';
import { claimDueDeliveries, enqueueWebhook } from '../../db/webhooks/webhookOutboxRepository';
import type { SafeFetchFn } from '../webhookDispatcher';
import { nextAttemptDelayMs, runWebhookOutboxPass } from '../webhookOutbox';
import { transitionIntent } from '../intentTransition';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

useGatewayDatabase();

const HOOK_URL = 'https://merchant.example/hook';

/** A `SafeFetchResult` backed by a real `IncomingMessage`, so no cast is needed. */
function fakeResult(status: number): SafeFetchResult {
  const response = new IncomingMessage(new Socket());
  response.destroy = () => response;
  return { response, status, headers: {}, finalUrl: HOOK_URL };
}

function respondWith(status: number): { fetch: SafeFetchFn; calls: () => number } {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      return fakeResult(status);
    },
    calls: () => calls,
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

async function merchantWithHook() {
  return seedMerchant({ webhookUrl: HOOK_URL, webhookSecret: 'whsec_test' });
}

async function enqueueFor(merchantId: string, intentId: string): Promise<string> {
  return enqueueWebhook(gatewayDb(), {
    merchantId,
    paymentIntentId: intentId,
    event: {
      id: `evt_${intentId}`,
      object: 'event',
      type: 'payment_intent.settled',
      created: new Date().toISOString(),
      data: { object: {} },
    } as never,
    url: HOOK_URL,
  });
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the webhook outbox', () => {
  beforeEach(async () => {
    await resetGatewayTables();
  });

  test('a 2xx settles the delivery and unschedules it', async () => {
    const merchant = await merchantWithHook();
    const intent = await seedIntent(merchant);
    const id = await enqueueFor(merchant.id, intent.id);

    const result = await runWebhookOutboxPass({ safeFetch: respondWith(200).fetch });

    expect(result).toMatchObject({ claimed: 1, delivered: 1 });
    const row = await findDeliveryForMerchant(gatewayDb(), id, merchant.id);
    expect(row?.lastStatus).toBe('delivered');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toBeNull();
    // Read off the table, not the DTO: the lease is dispatcher machinery and is
    // deliberately absent from `WebhookDeliveryRow`. A row that kept its lease
    // after its outcome was recorded is invisible to the claim query until the
    // lease expires, which turns a retryable delivery into a silent delay.
    expect(await leaseOwnerOf(id)).toBeNull();
  });

  /**
   * THE case this whole rebuild exists for.
   *
   * Under the previous inline delivery, three 503s inside 150ms was the end of
   * the event: `deliver()` returned `{delivered:false}`, a log row was written,
   * and nothing ever tried again. Here the row stays claimable with a real
   * schedule, and the merchant gets it when they come back.
   */
  test('a failing endpoint leaves the event queued rather than losing it', async () => {
    const merchant = await merchantWithHook();
    const intent = await seedIntent(merchant);
    const id = await enqueueFor(merchant.id, intent.id);

    const down = respondWith(503);
    const result = await runWebhookOutboxPass({ safeFetch: down.fetch });

    expect(result).toMatchObject({ claimed: 1, delivered: 0, retrying: 1 });
    const row = await findDeliveryForMerchant(gatewayDb(), id, merchant.id);
    expect(row?.lastStatus).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).not.toBeNull();
    expect(row?.lastError).toContain('503');
    expect(await leaseOwnerOf(id)).toBeNull();

    // And it is genuinely deliverable later, once the endpoint recovers.
    const recovered = respondWith(200);
    await runWebhookOutboxPass({
      safeFetch: recovered.fetch,
      now: new Date(Date.now() + 60_000),
    });
    const settled = await findDeliveryForMerchant(gatewayDb(), id, merchant.id);
    expect(settled?.lastStatus).toBe('delivered');
    expect(settled?.attempts).toBe(2);
  });

  test('a 4xx is terminal — no retry is scheduled for a payload the target refuses', async () => {
    const merchant = await merchantWithHook();
    const intent = await seedIntent(merchant);
    const id = await enqueueFor(merchant.id, intent.id);

    const result = await runWebhookOutboxPass({ safeFetch: respondWith(422).fetch });

    expect(result).toMatchObject({ claimed: 1, terminal: 1 });
    const row = await findDeliveryForMerchant(gatewayDb(), id, merchant.id);
    expect(row?.lastStatus).toBe('failed');
    expect(row?.nextAttemptAt).toBeNull();
  });

  /**
   * A row that is not yet due is not claimed. Without this the backoff is
   * decorative — every pass would re-attempt every failing row immediately,
   * which is a retry storm aimed at an endpoint that is already struggling.
   */
  test('a row scheduled for the future is not claimed', async () => {
    const merchant = await merchantWithHook();
    const intent = await seedIntent(merchant);
    const id = await enqueueFor(merchant.id, intent.id);
    await runWebhookOutboxPass({ safeFetch: respondWith(503).fetch });

    const second = respondWith(200);
    const result = await runWebhookOutboxPass({ safeFetch: second.fetch });

    expect(result.claimed).toBe(0);
    expect(second.calls()).toBe(0);
    const row = await findDeliveryForMerchant(gatewayDb(), id, merchant.id);
    expect(row?.lastStatus).toBe('pending');
  });

  /**
   * A row already leased is not handed out again.
   *
   * Note what this does and does NOT prove. The two claims run one after the
   * other, so the second is excluded by the LIVE-LEASE predicate, not by
   * `SKIP LOCKED` — the first update has already committed by then. The
   * genuinely concurrent case is the test below; both are here because they
   * fail for different reasons and a single test covering "two dispatchers"
   * would leave whichever mechanism it did not exercise unprotected.
   */
  test('a leased row is not handed to a later dispatcher', async () => {
    const merchant = await merchantWithHook();
    const intent = await seedIntent(merchant);
    await enqueueFor(merchant.id, intent.id);

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

  /**
   * The recovery path. A dispatcher killed between claiming and recording
   * leaves its lease behind; without the expired-lease branch in the claim
   * query the row would stay `pending` and claimable by nobody, forever — a
   * stuck event that looks exactly like a queued one.
   */
  test('an expired lease makes the row claimable again', async () => {
    const merchant = await merchantWithHook();
    const intent = await seedIntent(merchant);
    await enqueueFor(merchant.id, intent.id);

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
   * Two dispatchers claiming AT THE SAME TIME still produce one delivery.
   *
   * With both transactions open at once there is no COMMITTED lease for the
   * second to see, so this exercises a path the sequential test above cannot.
   *
   * What it does NOT prove is `SKIP LOCKED`: removing that clause leaves this
   * green, because a blocked claimant re-evaluates the row after the lock
   * clears and finds the lease. That was measured, not assumed — `SKIP LOCKED`
   * buys the second dispatcher returning in 8ms instead of 403ms, and no
   * assertion on the OUTCOME can see the difference. See the note on
   * `claimDueDeliveries`.
   */
  test('two dispatchers claiming concurrently share the row out exactly once', async () => {
    const merchant = await merchantWithHook();
    const intent = await seedIntent(merchant);
    await enqueueFor(merchant.id, intent.id);

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
      // Hold the transaction open across B's claim, so B meets an UNCOMMITTED
      // lock rather than a committed lease.
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
        })
      )
    );

    const [claimedByA, claimedByB] = await Promise.all([a, b]);

    expect(claimedByA.length + claimedByB.length).toBe(1);
  });

  test('a merchant who removed their endpoint terminates the delivery instead of looping', async () => {
    const merchant = await seedMerchant({ webhookUrl: HOOK_URL, webhookSecret: 'whsec_test' });
    const intent = await seedIntent(merchant);
    const id = await enqueueFor(merchant.id, intent.id);

    // The merchant clears their webhook after the event was enqueued.
    await gatewayDb()
      .update(merchants)
      .set({ webhookUrl: null, webhookSecret: null })
      .where(eq(merchants.id, merchant.id));

    const never = respondWith(200);
    const result = await runWebhookOutboxPass({ safeFetch: never.fetch });

    expect(result).toMatchObject({ claimed: 1, terminal: 1 });
    expect(never.calls()).toBe(0);
    const row = await findDeliveryForMerchant(gatewayDb(), id, merchant.id);
    expect(row?.lastStatus).toBe('failed');
    expect(row?.attempts).toBe(0);
  });

  /**
   * The transaction, which is the half of ADR 0001 D7 that nothing else can
   * check: the state change and the promise commit together.
   */
  test('a transition enqueues the merchant event in the same commit', async () => {
    const merchant = await merchantWithHook();
    const intent = await seedIntent(merchant);

    const moved = await transitionIntent(intent.id, {
      from: intent.status,
      status: 'rejected',
    });

    expect(moved.kind === 'updated' && moved.row.status).toBe('rejected');
    const queued = await gatewayDb()
      .select({ id: webhookDeliveries.id, eventType: webhookDeliveries.eventType })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.paymentIntentId, intent.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.eventType).toBe('payment_intent.rejected');
  });

  /** A merchant with no endpoint gets no queue — an event nobody can receive. */
  test('a transition for a merchant with no endpoint enqueues nothing', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant);

    await transitionIntent(intent.id, { from: intent.status, status: 'rejected' });

    const queued = await gatewayDb()
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.paymentIntentId, intent.id));
    expect(queued).toHaveLength(0);
  });
});

describe('the backoff schedule', () => {
  test('grows, and ends', () => {
    const mid = () => 0.5;
    expect(nextAttemptDelayMs(1, mid)).toBe(5_000);
    expect(nextAttemptDelayMs(2, mid)).toBe(30_000);
    expect(nextAttemptDelayMs(7, mid)).toBeGreaterThan(nextAttemptDelayMs(6, mid)!);
    // Past the end of the schedule the budget is spent — this is what makes a
    // row `dead` rather than retried forever against an endpoint nobody fixed.
    expect(nextAttemptDelayMs(8, mid)).toBeNull();
    expect(nextAttemptDelayMs(99, mid)).toBeNull();
  });

  /**
   * Jitter, and why it is not cosmetic: every merchant of one gateway tends to
   * fail at the same moment (a shared dependency, a deploy), so an unjittered
   * schedule re-synchronises all of them onto the same retry instant.
   */
  test('jitters within ±20% and never goes negative', () => {
    expect(nextAttemptDelayMs(1, () => 0)).toBe(4_000);
    expect(nextAttemptDelayMs(1, () => 1)).toBe(6_000);
    expect(nextAttemptDelayMs(1, () => 0.5)).toBe(5_000);
  });
});
