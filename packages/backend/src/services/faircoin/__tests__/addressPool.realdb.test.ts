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
import { paymentIntentOutputs, paymentIntents } from '../../../db/schema';
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
