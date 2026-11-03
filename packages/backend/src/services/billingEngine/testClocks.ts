/**
 * Test clocks (`clock_…`, ADR 0018 §3) — test mode only. A merchant creates a
 * clock frozen at some instant, attaches customers to it at creation, and
 * advances it: the engine then runs, for everything on the clock, every
 * obligation that fell due up to the new time — trials end, periods renew,
 * drafts finalize, payments are attempted and retried — in order, in seconds.
 *
 * Advancing completes before the request answers (`status: ready`); a clock
 * whose work does not settle reports `internal_failure`.
 */
import type { TestClock } from '@peable.to/shared-types';
import {
  findLiveTestClockForMerchant,
  findTestClockById,
  insertTestClock,
  listTestClocksForMerchant,
  lockTestClock,
  updateTestClock,
  type TestClockRow,
} from '../../db/billingEngine/testClockRepository';
import { listSubscriptions, lockSubscription } from '../../db/billingEngine/subscriptionRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { getDb } from '../../db/postgres';
import type { KeysetPage } from '../../db/keyset';
import { newId } from '../../lib/ids';
import { toTestClockDTO } from '../../lib/serializeBilling';
import { kickWebhookOutbox } from '../webhookOutbox';
import { BillingEngineError, invalid, missing } from './errors';
import { drainTestClock } from './scheduler';
import { subscriptionIsTerminal } from './stateMachines';
import { recordBillingEvent, transitionSubscription } from './transitions';

const DELETES_AFTER_MS = 30 * 86_400_000;
const MAX_ADVANCE_MS = 2 * 366 * 86_400_000;

function assertTestMode(merchant: MerchantRow): void {
  if (merchant.livemode) {
    // The same answer as every test helper (`lib/liveStream.ts`'s `refuseLivemode`).
    throw new BillingEngineError(
      'test_mode_only',
      'Test clocks are only available in test mode; use a test-mode (non-production) credential.',
      undefined,
      403,
    );
  }
}

async function record(
  merchant: MerchantRow,
  type:
    | 'test_helpers.test_clock.created'
    | 'test_helpers.test_clock.advancing'
    | 'test_helpers.test_clock.ready'
    | 'test_helpers.test_clock.deleted',
  object: TestClock,
): Promise<void> {
  await recordBillingEvent(getDb(), merchant.id, type, object);
  kickWebhookOutbox();
}

export async function createTestClock(
  merchant: MerchantRow,
  input: { frozenTime: number; name?: string },
): Promise<TestClockRow> {
  assertTestMode(merchant);
  const frozen = new Date(input.frozenTime * 1000);
  const row = await insertTestClock(getDb(), {
    publicId: newId('clock'),
    merchantId: merchant.id,
    name: input.name ?? null,
    frozenTime: frozen,
    deletesAfter: new Date(Date.now() + DELETES_AFTER_MS),
  });
  await record(merchant, 'test_helpers.test_clock.created', toTestClockDTO(row));
  return row;
}

export async function retrieveTestClock(
  merchant: MerchantRow,
  publicId: string,
): Promise<TestClockRow> {
  assertTestMode(merchant);
  const row = await findLiveTestClockForMerchant(getDb(), publicId, merchant.id);
  if (!row) throw missing('test clock');
  return row;
}

export async function listTestClocks(merchant: MerchantRow, page: KeysetPage) {
  assertTestMode(merchant);
  return listTestClocksForMerchant(getDb(), merchant.id, page);
}

/** Move the clock forward and run everything that fell due on it. */
export async function advanceTestClock(
  merchant: MerchantRow,
  publicId: string,
  frozenTime: number,
): Promise<TestClockRow> {
  const found = await retrieveTestClock(merchant, publicId);
  const target = new Date(frozenTime * 1000);
  const db = getDb();
  const advancing = await db.transaction(async (tx) => {
    const clock = await lockTestClock(tx, found.id);
    if (!clock || clock.deletedAt) throw missing('test clock');
    if (clock.status === 'advancing') {
      throw new BillingEngineError(
        'test_clock_unexpected_state',
        'this clock is already advancing',
        undefined,
        409,
      );
    }
    if (target.getTime() <= clock.frozenTime.getTime()) {
      throw invalid('frozen_time must be later than the clock’s current time', 'frozen_time');
    }
    if (target.getTime() - clock.frozenTime.getTime() > MAX_ADVANCE_MS) {
      throw invalid('a clock advances at most two years at a time', 'frozen_time');
    }
    const row = await updateTestClock(tx, clock.id, { frozenTime: target, status: 'advancing' });
    await recordBillingEvent(
      tx,
      merchant.id,
      'test_helpers.test_clock.advancing',
      toTestClockDTO(row),
    );
    return row;
  });
  kickWebhookOutbox();
  let settled = false;
  try {
    settled = await drainTestClock(advancing.id);
  } finally {
    const final = await updateTestClock(db, advancing.id, {
      status: settled ? 'ready' : 'internal_failure',
    });
    if (settled) await record(merchant, 'test_helpers.test_clock.ready', toTestClockDTO(final));
  }
  return (await findTestClockById(db, advancing.id)) ?? advancing;
}

/**
 * Delete a clock: every live subscription on it is cancelled at its frozen
 * time (nothing on a deleted clock runs again); the clock stays readable to
 * the objects that name it.
 */
export async function deleteTestClock(
  merchant: MerchantRow,
  publicId: string,
): Promise<TestClockRow> {
  const found = await retrieveTestClock(merchant, publicId);
  const db = getDb();
  const deleted = await db.transaction(async (tx) => {
    const clock = await lockTestClock(tx, found.id);
    if (!clock || clock.deletedAt) throw missing('test clock');
    let after: string | undefined;
    for (;;) {
      const page = await listSubscriptions(tx, {
        merchantId: merchant.id,
        testClockId: clock.id,
        status: 'all',
        page: { limit: 100, ...(after ? { after } : {}) },
      });
      for (const row of page.data) {
        if (subscriptionIsTerminal(row.status)) continue;
        const locked = await lockSubscription(tx, row.id);
        if (!locked || subscriptionIsTerminal(locked.status)) continue;
        await transitionSubscription(tx, locked, 'canceled', {
          canceledAt: clock.frozenTime,
          endedAt: clock.frozenTime,
          cancellationReason: 'cancellation_requested',
          nextActionAt: null,
        });
      }
      if (!page.hasMore) break;
      after = page.data.at(-1)?.id;
    }
    const row = await updateTestClock(tx, clock.id, { deletedAt: new Date() });
    await recordBillingEvent(
      tx,
      merchant.id,
      'test_helpers.test_clock.deleted',
      toTestClockDTO(row),
    );
    return row;
  });
  kickWebhookOutbox();
  return deleted;
}
