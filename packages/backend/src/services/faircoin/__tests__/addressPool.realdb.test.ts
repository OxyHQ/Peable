/**
 * How a recipient's FairCoin addresses are handed out (ADR 0021 D9, amended
 * 2026-11-06): every payment gets a FRESH index, an address is never handed out
 * twice, there is no ceiling, and what bounds the set is the recipient's unpaid
 * addresses of the last day — against a REAL server, because the bound is a
 * count under a lock and only a real server can show two confirms racing it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { bytesToHex, deriveSocialReceiveAddress, getNetwork } from '@fairco.in/core';
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
import type { PaymentIntentRow } from '../../../db/payments/paymentIntentRepository';
import { paymentIntentOutputs, paymentIntents, socialReceiveCursors } from '../../../db/schema';
import { listReceiveAddresses } from '../../../db/social/receiveAddresses';
import { readReservedThrough } from '../../../db/social/receiveCursor';
import { insertSendAttribution } from '../../../db/social/sendAttribution';
import { createIntent } from '../../createIntent';
import { transitionIntent } from '../../intentTransition';
import { reserveSocialSendAddress } from '../../socialReceive';
import {
  FaircoinCapacityError,
  useAddressUsageReader,
  useMaxUnpaidAddresses,
} from '../addressPool';
import { faircoinAvailability } from '../recipient';

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

function bound(value: number) {
  const previous = useMaxUnpaidAddresses(value);
  restores.push(() => useMaxUnpaidAddresses(previous));
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

async function cancel(intent: PaymentIntentRow): Promise<void> {
  const result = await transitionIntent(intent.id, {
    from: 'requires_action',
    status: 'canceled',
    cancellationReason: 'abandoned',
  });
  expect(result.kind).toBe('updated');
}

/** Move a payment's output (and its cancellation) `hours` into the past. */
async function age(intent: PaymentIntentRow, hours: number): Promise<void> {
  await gatewayDb()
    .update(paymentIntentOutputs)
    .set({ createdAt: sql`now() - (${hours}::integer * interval '1 hour')` })
    .where(eq(paymentIntentOutputs.paymentIntentId, intent.id));
}

async function outputOf(intent: PaymentIntentRow) {
  const [row] = await gatewayDb()
    .select()
    .from(paymentIntentOutputs)
    .where(eq(paymentIntentOutputs.paymentIntentId, intent.id));
  return must(row);
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('never reused', () => {
  test('a cancelled payment keeps its address for ever: the next payment takes a fresh index, whatever the chain says', async () => {
    chainSays('unused');
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const first = await pay(merchant);
    expect((await outputOf(first)).derivationIndex).toBe(1);
    expect(first.address).toBe(
      deriveSocialReceiveAddress(testIdentityPublicKey(owner), 1, getNetwork('testnet')),
    );
    await cancel(first);
    await age(first, 48);
    const second = await pay(merchant);
    expect(second.address).not.toBe(first.address);
    expect((await outputOf(second)).derivationIndex).toBe(2);
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(2);
  });

  test('payments and @username to one account share one cursor and never one address', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const paid = await pay(merchant);
    const asked = must(
      await reserveSocialSendAddress({
        senderUserId: 'sender_shared',
        recipientUserId: owner,
        network: 'testnet',
      }),
    );
    const again = await pay(merchant);
    expect(new Set([paid.address, asked.address, again.address]).size).toBe(3);
    expect(asked.index).toBe(2);
    const page = await listReceiveAddresses(gatewayDb(), owner, 'testnet', 0, 10);
    expect(page.addresses.map((row) => [row.derivationIndex, row.address])).toEqual([
      [1, must(paid.address)],
      [2, asked.address],
      [3, must(again.address)],
    ]);
    expect(page.addresses.every((row) => row.identityPublicKey === asked.identityPublicKey)).toBe(
      true,
    );
  });

  test('an index whose address history already holds is skipped, so nothing is handed out twice', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const key = testIdentityPublicKey(owner);
    // History: an attribution at index 1 and 2 that its cursor does not know
    // about (migration 0009 deleted keyless cursors and kept their rows).
    for (const index of [1, 2]) {
      await insertSendAttribution(gatewayDb(), {
        address: deriveSocialReceiveAddress(key, index, getNetwork('testnet')),
        network: 'testnet',
        senderUserId: 'sender_history',
        recipientUserId: owner,
        derivationIndex: index,
        identityPublicKey: bytesToHex(key),
      });
    }
    const fresh = await pay(merchant);
    expect((await outputOf(fresh)).derivationIndex).toBe(3);
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(3);
  });

  test('a create that loses its idempotency key race spends no index', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const [a, b] = await Promise.all([pay(merchant, 'same-key'), pay(merchant, 'same-key')]);
    expect(must(a).id).toBe(must(b).id);
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(1);
  });

  test('no ceiling: an index past the old 1 980 limit is handed out', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    await pay(merchant);
    await gatewayDb()
      .update(socialReceiveCursors)
      .set({ nextDerivationIndex: 250_000 })
      .where(eq(socialReceiveCursors.oxyUserId, owner));
    const far = await pay(merchant);
    expect((await outputOf(far)).derivationIndex).toBe(250_000);
    expect(far.address).toBe(
      deriveSocialReceiveAddress(testIdentityPublicKey(owner), 250_000, getNetwork('testnet')),
    );
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the daily bound on unpaid addresses', () => {
  test('at the bound a new FairCoin payment is refused and reserves nothing; a paid one never counts', async () => {
    bound(2);
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
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(2);

    // Cancelling frees nothing: a cancelled address is still unpaid today.
    await cancel(first);
    await expect(pay(merchant)).rejects.toBeInstanceOf(FaircoinCapacityError);

    // A paid address is not unpaid: settling one makes room.
    await gatewayDb()
      .update(paymentIntents)
      .set({
        status: 'succeeded',
        canceledAt: null,
        cancellationReason: null,
        txid: 'aa'.repeat(32),
        amountReceived: '100000000',
      })
      .where(eq(paymentIntents.id, first.id));
    const third = await pay(merchant);
    expect((await outputOf(third)).derivationIndex).toBe(3);
  });

  test('a reported txid that never settles still counts (processing is not paid)', async () => {
    bound(1);
    const merchant = await seedMerchant({ network: 'testnet' });
    const first = await pay(merchant);
    await gatewayDb()
      .update(paymentIntents)
      .set({ status: 'processing', txid: 'bb'.repeat(32) })
      .where(eq(paymentIntents.id, first.id));
    await expect(pay(merchant)).rejects.toBeInstanceOf(FaircoinCapacityError);
  });

  test('the window is a day: an unpaid address older than that stops counting', async () => {
    bound(1);
    const merchant = await seedMerchant({ network: 'testnet' });
    const first = await pay(merchant);
    await cancel(first);
    await expect(pay(merchant)).rejects.toBeInstanceOf(FaircoinCapacityError);
    await age(first, 25);
    const next = await pay(merchant);
    expect(next.address).not.toBe(first.address);
  });

  test('concurrent confirms cannot both pass the bound: the count and the reservation are one decision', async () => {
    bound(3);
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => pay(merchant)));
    const made = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    expect(made).toHaveLength(3);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(FaircoinCapacityError);
      }
    }
    expect(new Set(made.map((intent) => intent.address)).size).toBe(3);
    expect((await readReservedThrough(gatewayDb(), owner, 'testnet')).reservedThrough).toBe(3);
  });

  test("one recipient's bound is not another's", async () => {
    bound(1);
    const a = await seedMerchant({ network: 'testnet' });
    const b = await seedMerchant({ network: 'testnet' });
    await pay(a);
    await expect(pay(a)).rejects.toBeInstanceOf(FaircoinCapacityError);
    await pay(b);
  });
});
