/**
 * The expiry sweeper.
 *
 * `expire` and `payment_intent.canceled` have been in the state machine and in
 * the published webhook contract since the first release, with NO production
 * caller — an intent past its `expiresAt` simply stayed `created` forever. A
 * merchant subscribing to that event to release an inventory reservation would
 * have held it indefinitely.
 *
 * The case that matters most here is the NEGATIVE one: an intent whose payer
 * has already committed funds must never be expired.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { events, paymentIntents, webhookDeliveries } from '../../db/schema';
import { runExpirySweep } from '../expirySweeper';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

useGatewayDatabase();

const PAST = new Date(Date.now() - 60_000);

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await gatewayDb()
    .select({ status: paymentIntents.status })
    .from(paymentIntents)
    .where(eq(paymentIntents.id, id));
  return row?.status;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the expiry sweeper', () => {
  beforeEach(async () => {
    await resetGatewayTables();
  });

  test('expires an intent nobody paid', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant, { expiresAt: PAST });

    const result = await runExpirySweep();

    expect(result).toEqual({ examined: 1, expired: 1 });
    expect(await statusOf(intent.id)).toBe('canceled');
  });

  test('leaves an intent whose time has not come', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant, {
      expiresAt: new Date(Date.now() + 600_000),
    });

    const result = await runExpirySweep();

    expect(result).toEqual({ examined: 0, expired: 0 });
    expect(await statusOf(intent.id)).toBe('requires_action');
  });

  /**
   * The one that would cost money.
   *
   * A `processing` FairCoin intent has coins on their way to its address.
   * Expiring it would mark the payment abandoned while the transaction
   * confirms, and the settlement watcher — which only polls `processing` —
   * would stop looking at it. The payer's funds would arrive at an address nothing
   * is watching, attributable to nobody.
   *
   * `expiresAt` is deliberately in the PAST here: the guard has to be the
   * status list, not the clock, or a slow confirmation would be enough.
   */
  test('never expires an intent whose payer has broadcast', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant, { expiresAt: PAST });
    await gatewayDb()
      .update(paymentIntents)
      .set({ status: 'processing', txid: 'a'.repeat(64) })
      .where(eq(paymentIntents.id, intent.id));

    const result = await runExpirySweep();

    expect(result).toEqual({ examined: 0, expired: 0 });
    expect(await statusOf(intent.id)).toBe('processing');
  });

  test('never expires an intent that already succeeded', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant, { expiresAt: PAST });
    await gatewayDb()
      .update(paymentIntents)
      .set({ status: 'processing', txid: 'b'.repeat(64) })
      .where(eq(paymentIntents.id, intent.id));
    await gatewayDb()
      .update(paymentIntents)
      .set({ status: 'succeeded' })
      .where(eq(paymentIntents.id, intent.id));

    const result = await runExpirySweep();

    expect(result).toEqual({ examined: 0, expired: 0 });
    expect(await statusOf(intent.id)).toBe('succeeded');
  });

  /** The event a merchant can finally receive, enqueued in the same commit. */
  test('enqueues payment_intent.canceled for a merchant with an endpoint', async () => {
    const merchant = await seedMerchant({
      webhookUrl: 'https://merchant.example/hook',
      webhookSecret: 'whsec_test',
    });
    const intent = await seedIntent(merchant, { expiresAt: PAST });

    await runExpirySweep();

    const queued = await gatewayDb()
      .select({ eventType: events.type, status: webhookDeliveries.lastStatus })
      .from(webhookDeliveries)
      .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
      .where(eq(events.paymentIntentId, intent.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.eventType).toBe('payment_intent.canceled');
    expect(queued[0]?.status).toBe('pending');
  });

  test('is idempotent — a second sweep finds nothing left', async () => {
    const merchant = await seedMerchant();
    await seedIntent(merchant, { expiresAt: PAST });

    await runExpirySweep();
    const second = await runExpirySweep();

    expect(second).toEqual({ examined: 0, expired: 0 });
  });
});
