/**
 * The bound on a recipient's FairCoin tree (ADR 0021 D9): an address of a
 * cancelled payment that the chain shows unused is recycled before a fresh
 * index is minted, and no more than the cap of the recipient's addresses are
 * ever open at once — against a REAL server, because the cap is a count under a
 * lock and only a real server can show two confirms racing it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { deriveSocialReceiveAddress, getNetwork } from '@fairco.in/core';
import { eq, sql } from 'drizzle-orm';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedMerchant,
  useGatewayDatabase,
} from '../../../__tests__/helpers/gatewayTestDatabase';
import { must } from '../../../__tests__/helpers/must';
import { testIdentityPublicKey } from '../../../__tests__/setup/identityKeys';
import type { MerchantRow } from '../../../db/merchants/merchantRepository';
import {
  findIntentsByAddresses,
  type PaymentIntentRow,
} from '../../../db/payments/paymentIntentRepository';
import { SOCIAL_RECEIVE_INDEX_LIMIT } from '@peable.to/contracts/vocabulary';
import { paymentIntentOutputs, paymentIntents, socialReceiveCursors } from '../../../db/schema';
import { readReservedThrough } from '../../../db/social/receiveCursor';
import { createIntent } from '../../createIntent';
import { transitionIntent } from '../../intentTransition';
import { useIdentityKeyResolver } from '../../socialReceive';
import { FaircoinCapacityError, useAddressUsageReader, useMaxOpenAddresses } from '../addressPool';
import { faircoinAvailability } from '../recipient';

useGatewayDatabase();

const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  if (POSTGRES_TESTS_ENABLED) await resetGatewayTables();
});

function chainSays(answer: 'unused' | 'used' | 'unknown'): string[] {
  const asked: string[] = [];
  const previous = useAddressUsageReader(async (address) => {
    asked.push(address);
    return answer;
  });
  restores.push(() => useAddressUsageReader(previous));
  return asked;
}

function cap(value: number) {
  const previous = useMaxOpenAddresses(value);
  restores.push(() => useMaxOpenAddresses(previous));
}

async function pay(merchant: MerchantRow, idempotencyKey?: string): Promise<PaymentIntentRow> {
  return (
    await createIntent({
      merchant,
      amount: '100000000',
      rail: 'faircoin',
      network: 'testnet',
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
  ).intent;
}

/** Cancel a payment (`abandoned`), `ago` seconds in the past. */
async function cancel(intent: PaymentIntentRow, agoSeconds: number): Promise<void> {
  const result = await transitionIntent(intent.id, {
    from: 'requires_action',
    status: 'canceled',
    cancellationReason: 'abandoned',
  });
  expect(result.kind).toBe('updated');
  await gatewayDb()
    .update(paymentIntents)
    .set({ canceledAt: sql`now() - (${agoSeconds}::integer * interval '1 second')` })
    .where(eq(paymentIntents.id, intent.id));
}

async function outputOf(intent: PaymentIntentRow) {
  const [row] = await gatewayDb()
    .select()
    .from(paymentIntentOutputs)
    .where(eq(paymentIntentOutputs.paymentIntentId, intent.id));
  return must(row);
}

const HOUR = 60 * 60;

describe.skipIf(!POSTGRES_TESTS_ENABLED)('recycling', () => {
  test('an abandoned address the chain shows unused is handed out again; the cursor does not move', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const first = await pay(merchant);
    const firstOutput = await outputOf(first);
    expect(firstOutput.derivationIndex).toBe(1);
    expect(first.address).toBe(
      deriveSocialReceiveAddress(testIdentityPublicKey(owner), 1, getNetwork('testnet')),
    );
    await cancel(first, 2 * HOUR);

    const asked = chainSays('unused');
    const second = await pay(merchant);
    expect(second.address).toBe(first.address);
    expect(asked).toEqual([must(first.address)]);
    expect((await outputOf(second)).derivationIndex).toBe(1);
    // The previous holder keeps its address for its own history, marked recycled.
    expect((await outputOf(first)).recycledAt).not.toBeNull();
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(1);
    // "Whose payment is this address?" answers the holder only.
    const holders = await findIntentsByAddresses(gatewayDb(), [must(first.address)]);
    expect(holders.map((intent) => intent.id)).toEqual([second.id]);
  });

  test('within the quarantine an abandoned address is not offered: a late payer still pays it alone', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const first = await pay(merchant);
    await cancel(first, 10 * 60);
    const asked = chainSays('unused');
    const second = await pay(merchant);
    expect(second.address).not.toBe(first.address);
    expect(asked).toEqual([]);
  });

  test('an address the chain shows used is retired, never offered again', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const first = await pay(merchant);
    await cancel(first, 2 * HOUR);
    chainSays('used');
    const second = await pay(merchant);
    expect(second.address).not.toBe(first.address);
    expect((await outputOf(first)).retiredAt).not.toBeNull();
    // Retired is final: an Explorer that now says "unused" does not bring it back.
    chainSays('unused');
    const third = await pay(merchant);
    expect(third.address).not.toBe(first.address);
  });

  test('an Explorer that cannot tell recycles nothing, and retires nothing', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const first = await pay(merchant);
    await cancel(first, 2 * HOUR);
    chainSays('unknown');
    const second = await pay(merchant);
    expect(second.address).not.toBe(first.address);
    const kept = await outputOf(first);
    expect(kept.retiredAt).toBeNull();
    expect(kept.recycledAt).toBeNull();
  });

  test("an address that no longer derives from the recipient's key is retired (ADR 0002)", async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const first = await pay(merchant);
    await cancel(first, 2 * HOUR);
    const asked = chainSays('unused');
    const previous = useIdentityKeyResolver(async () => testIdentityPublicKey(`${owner}:rotated`));
    restores.push(() => useIdentityKeyResolver(previous));
    const second = await pay(merchant);
    expect(second.address).not.toBe(first.address);
    expect(asked).toEqual([]);
    expect((await outputOf(first)).retiredAt).not.toBeNull();
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the cap on open addresses', () => {
  test('at the cap a new FairCoin payment is refused; a freed address makes room again', async () => {
    cap(2);
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const first = await pay(merchant);
    await pay(merchant);
    await expect(pay(merchant)).rejects.toBeInstanceOf(FaircoinCapacityError);
    expect(
      await faircoinAvailability({
        network: 'testnet',
        currency: 'FAIR',
        recipientAccountId: owner,
      }),
    ).toEqual({ available: false, unavailable_reason: 'temporarily_unavailable' });
    // The refusal reserved nothing.
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(2);

    // Cancelled within the quarantine: still open.
    await cancel(first, 10 * 60);
    await expect(pay(merchant)).rejects.toBeInstanceOf(FaircoinCapacityError);
    // Past it, and the chain shows it unused: recycled, at the cap.
    await gatewayDb()
      .update(paymentIntents)
      .set({ canceledAt: sql`now() - interval '2 hours'` })
      .where(eq(paymentIntents.id, first.id));
    chainSays('unused');
    const third = await pay(merchant);
    expect(third.address).toBe(first.address);
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(2);
  });

  test('concurrent confirms cannot both pass the cap: the count and the mint are one decision', async () => {
    cap(3);
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => pay(merchant)));
    const made = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(made).toHaveLength(3);
    for (const outcome of refused) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(FaircoinCapacityError);
    }
    expect(new Set(made.map((intent) => intent.address)).size).toBe(3);
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(3);
  });

  test('a create that loses its idempotency key race spends no index', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const [a, b] = await Promise.all([pay(merchant, 'same-key'), pay(merchant, 'same-key')]);
    expect(must(a).id).toBe(must(b).id);
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(1);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)(
  'concurrent confirms recycle (ADR 0021 D9, amended)',
  () => {
    test('N parallel confirms with N candidates recycle all N: the cursor does not move', async () => {
      const merchant = await seedMerchant({ network: 'testnet' });
      const owner = must(merchant.ownerAccountId);
      const N = 8;
      const abandoned: PaymentIntentRow[] = [];
      for (let i = 0; i < N; i += 1) abandoned.push(await pay(merchant));
      for (const intent of abandoned) await cancel(intent, 2 * HOUR);
      const through = (await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough;
      expect(through).toBe(N);

      chainSays('unused');
      const made = await Promise.all(Array.from({ length: N }, () => pay(merchant)));
      const addresses = new Set(made.map((intent) => must(intent.address)));
      expect(addresses.size).toBe(N);
      expect(addresses).toEqual(new Set(abandoned.map((intent) => must(intent.address))));
      expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(N);
    });

    test('more confirms than candidates: the candidates are all used, and only the rest mint', async () => {
      const merchant = await seedMerchant({ network: 'testnet' });
      const owner = must(merchant.ownerAccountId);
      const abandoned = [await pay(merchant), await pay(merchant), await pay(merchant)];
      for (const intent of abandoned) await cancel(intent, 2 * HOUR);
      chainSays('unused');
      const made = await Promise.all(Array.from({ length: 5 }, () => pay(merchant)));
      const recycled = made.filter((intent) =>
        abandoned.some((old) => old.address === intent.address),
      );
      expect(recycled).toHaveLength(3);
      expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(5);
    });

    test('a candidate the chain showed unused recently is claimed without another read', async () => {
      const merchant = await seedMerchant({ network: 'testnet' });
      const first = await pay(merchant);
      await cancel(first, 2 * HOUR);
      await gatewayDb()
        .update(paymentIntentOutputs)
        .set({ recycleCheckedAt: sql`now() - interval '1 minute'` })
        .where(eq(paymentIntentOutputs.paymentIntentId, first.id));
      const asked = chainSays('unknown');
      const second = await pay(merchant);
      expect(second.address).toBe(first.address);
      expect(asked).toEqual([]);
    });

    test('a stale check is read again: an Explorer that cannot tell recycles nothing', async () => {
      const merchant = await seedMerchant({ network: 'testnet' });
      const first = await pay(merchant);
      await cancel(first, 2 * HOUR);
      await gatewayDb()
        .update(paymentIntentOutputs)
        .set({ recycleCheckedAt: sql`now() - interval '1 hour'` })
        .where(eq(paymentIntentOutputs.paymentIntentId, first.id));
      const asked = chainSays('unknown');
      const second = await pay(merchant);
      expect(second.address).not.toBe(first.address);
      expect(asked).toEqual([must(first.address)]);
      // The lease it took to look was given back.
      expect((await outputOf(first)).recycleLeaseUntil).toBeNull();
    });
  },
);

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the tree ceiling (ADR 0021 D9, amended)', () => {
  /** Move the owner's cursor as if every index below `next` had been handed out. */
  async function cursorAt(owner: string, next: number) {
    await gatewayDb()
      .update(socialReceiveCursors)
      .set({ nextDerivationIndex: next })
      .where(eq(socialReceiveCursors.oxyUserId, owner));
  }

  test('the last watched index is handed out; past it FairCoin is refused as capacity, the cursor unchanged', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    await pay(merchant);
    await cursorAt(owner, SOCIAL_RECEIVE_INDEX_LIMIT - 1);
    chainSays('unknown');
    const last = await pay(merchant);
    expect((await outputOf(last)).derivationIndex).toBe(SOCIAL_RECEIVE_INDEX_LIMIT - 1);
    const refusal = await pay(merchant).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(FaircoinCapacityError);
    expect((refusal as FaircoinCapacityError).full).toBe(true);
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(
      SOCIAL_RECEIVE_INDEX_LIMIT - 1,
    );
    expect(
      await faircoinAvailability({
        network: 'testnet',
        currency: 'FAIR',
        recipientAccountId: owner,
      }),
    ).toEqual({ available: false, unavailable_reason: 'temporarily_unavailable' });
  });

  // Round-3 review: the recycling query had no `index < limit` filter, so an
  // address minted at or above the ceiling before it existed could be handed
  // out again — to a payer, at an index the wallet may not watch.
  test('an address at or above the ceiling is never recycled; the chain is not even asked', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const first = await pay(merchant);
    await cancel(first, 2 * HOUR);
    // As if minted before the ceiling: the address really derives at that index,
    // so only the ceiling (not the key check) can refuse it.
    for (const index of [SOCIAL_RECEIVE_INDEX_LIMIT, SOCIAL_RECEIVE_INDEX_LIMIT - 1]) {
      const address = deriveSocialReceiveAddress(
        testIdentityPublicKey(owner),
        index,
        getNetwork('testnet'),
      );
      await gatewayDb()
        .update(paymentIntentOutputs)
        .set({ derivationIndex: index, address })
        .where(eq(paymentIntentOutputs.paymentIntentId, first.id));
      await gatewayDb()
        .update(paymentIntents)
        .set({ address })
        .where(eq(paymentIntents.id, first.id));
      const asked = chainSays('unused');
      const next = await pay(merchant);
      if (index >= SOCIAL_RECEIVE_INDEX_LIMIT) {
        expect(asked).toEqual([]);
        expect(next.address).not.toBe(address);
        const kept = await outputOf(first);
        expect(kept.recycledAt).toBeNull();
        expect(kept.retiredAt).toBeNull();
        // Free the minted one again so the next round starts the same way.
        await cancel(next, 10 * 60);
      } else {
        // The last index below it is still recycled.
        expect(asked).toEqual([address]);
        expect(next.address).toBe(address);
      }
    }
  });

  test('a full tree still recycles', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const first = await pay(merchant);
    await cancel(first, 2 * HOUR);
    await cursorAt(owner, SOCIAL_RECEIVE_INDEX_LIMIT);
    chainSays('unused');
    expect(
      await faircoinAvailability({
        network: 'testnet',
        currency: 'FAIR',
        recipientAccountId: owner,
      }),
    ).toEqual({ available: true, unavailable_reason: null });
    const second = await pay(merchant);
    expect(second.address).toBe(first.address);
    await expect(pay(merchant)).rejects.toBeInstanceOf(FaircoinCapacityError);
  });
});
