/**
 * The daily `@username` bounds (ADR 0021 D9, review round 4) against a REAL
 * server: one sender is handed at most `MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER`
 * fresh addresses of one recipient's a day, however it treats them, and a
 * sender the recipient already served today only while the recipient is below
 * half its bound. Both are counts under the recipient's lock, held in the
 * database — so only a real server shows concurrent asks racing them, and they
 * hold on every task.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { must } from '../../__tests__/helpers/must';
import { socialSendAttributions } from '../../db/schema';
import { readReservedThrough } from '../../db/social/receiveCursor';
import { FaircoinCapacityError, useAddressUsageReader } from '../faircoin/addressPool';
import {
  MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER,
  reserveSocialSendAddress,
  reuseUnpaidSocialAddress,
  SocialSenderBoundError,
  useMaxFreshSocialAddresses,
} from '../socialReceive';

useGatewayDatabase();

const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  if (POSTGRES_TESTS_ENABLED) await resetGatewayTables();
});

function chainSays(answer: 'unused' | 'used' | 'unknown') {
  const previous = useAddressUsageReader(async () => answer);
  restores.push(() => useAddressUsageReader(previous));
}

function recipientBound(value: number) {
  const previous = useMaxFreshSocialAddresses(value);
  restores.push(() => useMaxFreshSocialAddresses(previous));
}

/** What the route does for a fresh address: the sender's held one first, then a reservation. */
async function ask(senderUserId: string, recipientUserId: string) {
  const held = await reuseUnpaidSocialAddress(senderUserId, recipientUserId, 'testnet');
  if (held.reusable) return { index: held.index, address: held.address, reused: true };
  const reserved = must(
    await reserveSocialSendAddress({
      senderUserId,
      recipientUserId,
      network: 'testnet',
      seenLatestAttributionId: held.latestAttributionId,
    }),
  );
  return { index: reserved.index, address: reserved.address, reused: false };
}

async function rowsOf(senderUserId: string, recipientUserId: string) {
  return gatewayDb()
    .select()
    .from(socialSendAttributions)
    .where(
      and(
        eq(socialSendAttributions.senderUserId, senderUserId),
        eq(socialSendAttributions.recipientUserId, recipientUserId),
      ),
    );
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('one sender, one recipient, one day', () => {
  test(`a sender dusting every address it is handed is cut off after ${MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER}, reserving nothing`, async () => {
    // Every address it got reads used: the dust attack, which defeats the
    // "hand back the unpaid one" rule.
    chainSays('used');
    const handed = [];
    for (let i = 0; i < MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER; i += 1) {
      handed.push(await ask('user_duster', 'user_victim'));
    }
    expect(handed.every((one) => !one.reused)).toBe(true);
    expect(new Set(handed.map((one) => one.address)).size).toBe(
      MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER,
    );

    await expect(ask('user_duster', 'user_victim')).rejects.toBeInstanceOf(SocialSenderBoundError);
    expect(await rowsOf('user_duster', 'user_victim')).toHaveLength(
      MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER,
    );
    expect((await readReservedThrough(gatewayDb(), 'user_victim', 'testnet')).reservedThrough).toBe(
      MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER,
    );
    // A new sender still pays the recipient.
    expect((await ask('user_new_sender', 'user_victim')).reused).toBe(false);
  });

  test('the bound is per (sender, recipient): the capped sender pays someone else, another sender pays this one', async () => {
    chainSays('used');
    for (let i = 0; i < MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER; i += 1) {
      await ask('user_s', 'user_r1');
    }
    await expect(ask('user_s', 'user_r1')).rejects.toBeInstanceOf(SocialSenderBoundError);
    expect((await ask('user_s', 'user_r2')).reused).toBe(false);
    expect((await ask('user_t', 'user_r1')).reused).toBe(false);
  });

  test('the window is a day: addresses handed out over 24 hours ago stop counting', async () => {
    chainSays('used');
    for (let i = 0; i < MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER; i += 1) {
      await ask('user_daily', 'user_r');
    }
    await expect(ask('user_daily', 'user_r')).rejects.toBeInstanceOf(SocialSenderBoundError);
    await gatewayDb()
      .update(socialSendAttributions)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(socialSendAttributions.senderUserId, 'user_daily'));
    expect((await ask('user_daily', 'user_r')).reused).toBe(false);
  });

  test('concurrent asks cannot pass the bound: the count and the reservation are one decision', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        reserveSocialSendAddress({
          senderUserId: 'user_racer',
          recipientUserId: 'user_raced',
          network: 'testnet',
        }),
      ),
    );
    const made = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' && outcome.value ? [outcome.value] : [],
    );
    expect(made).toHaveLength(MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(SocialSenderBoundError);
      }
    }
    expect(new Set(made.map((one) => one.address)).size).toBe(
      MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER,
    );
    expect(await rowsOf('user_racer', 'user_raced')).toHaveLength(
      MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER,
    );
    expect((await readReservedThrough(gatewayDb(), 'user_raced', 'testnet')).reservedThrough).toBe(
      MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER,
    );
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)("the recipient's bound keeps half for new senders", () => {
  test('a sender already served today is served only below half the bound; a new sender up to all of it', async () => {
    chainSays('used');
    recipientBound(10);
    // One account dusting: its first address and four more, all below half (5).
    for (let i = 0; i < MAX_FRESH_SOCIAL_ADDRESSES_PER_SENDER; i += 1) {
      await ask('user_a', 'user_r');
    }
    // A second account's first is served; its repeat is not — the recipient is at half.
    expect((await ask('user_b', 'user_r')).reused).toBe(false);
    await expect(ask('user_b', 'user_r')).rejects.toBeInstanceOf(FaircoinCapacityError);
    // New senders take the rest of the bound, one account each, and no more.
    for (const sender of ['user_c', 'user_d', 'user_e', 'user_f']) {
      expect((await ask(sender, 'user_r')).reused).toBe(false);
    }
    await expect(ask('user_g', 'user_r')).rejects.toBeInstanceOf(FaircoinCapacityError);
    const [count] = await gatewayDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(socialSendAttributions)
      .where(eq(socialSendAttributions.recipientUserId, 'user_r'));
    expect(count?.n).toBe(10);
  });
});
