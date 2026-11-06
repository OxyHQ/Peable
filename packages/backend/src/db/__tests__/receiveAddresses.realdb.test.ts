/**
 * `listReceiveAddresses` reads a page in ONE snapshot (ADR 0021 D9, review
 * round 4): the sync cursor is exact only if the payment outputs and the
 * `@username` attributions of a page are read at the same instant. Two reads
 * at two instants could see index 6 committed in one table and miss index 5
 * committed in the other between them — and the cursor would then skip 5.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { must } from '../../__tests__/helpers/must';
import { createIntent } from '../../services/createIntent';
import { reserveSocialSendAddress } from '../../services/socialReceive';
import type { MerchantRow } from '../merchants/merchantRepository';
import type { Database } from '../postgres';
import { listReceiveAddresses } from '../social/receiveAddresses';

useGatewayDatabase();

afterEach(async () => {
  if (POSTGRES_TESTS_ENABLED) await resetGatewayTables();
});

async function pay(merchant: MerchantRow): Promise<string> {
  const { intent } = await createIntent({
    merchant,
    amount: '100000000',
    rail: 'faircoin',
    network: 'testnet',
  });
  return must(intent.address);
}

async function ask(recipientUserId: string, senderUserId: string): Promise<string> {
  return must(await reserveSocialSendAddress({ senderUserId, recipientUserId, network: 'testnet' }))
    .address;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('one snapshot per page', () => {
  test('both tables of a page are read at one instant: rows committed after it are not in the page', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const first = await pay(merchant);
    const second = await ask(owner, 'user_sender_1');

    const configs: unknown[] = [];
    let later: string[] = [];
    const real = gatewayDb();
    // The page's transaction, with an output and an attribution committed by
    // OTHER connections once its snapshot is taken and before it reads.
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (
            run: Parameters<Database['transaction']>[0],
            config: Parameters<Database['transaction']>[1],
          ) => {
            configs.push(config);
            return target.transaction(async (tx) => {
              await tx.execute(sql`select 1`);
              later = [await pay(merchant), await ask(owner, 'user_sender_2')];
              return run(tx);
            }, config);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database;

    const page = await listReceiveAddresses(db, owner, 'testnet', 0, 10);
    expect(configs).toEqual([{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);
    expect(page.addresses.map((row) => [row.derivationIndex, row.address])).toEqual([
      [1, first],
      [2, second],
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.syncCursor).toBe(2);

    // The next sync, from that cursor, misses nothing.
    const next = await listReceiveAddresses(real, owner, 'testnet', page.syncCursor, 10);
    expect(next.addresses.map((row) => [row.derivationIndex, row.address])).toEqual([
      [3, must(later[0])],
      [4, must(later[1])],
    ]);
  });

  test('pages across both tables are unchanged: ascending index, has_more, the cursor', async () => {
    const merchant = await seedMerchant({ network: 'testnet' });
    const owner = must(merchant.ownerAccountId);
    const handed = [
      await pay(merchant),
      await ask(owner, 'user_a'),
      await ask(owner, 'user_b'),
      await pay(merchant),
    ];
    const head = await listReceiveAddresses(gatewayDb(), owner, 'testnet', 0, 2);
    expect(head.addresses.map((row) => row.address)).toEqual(handed.slice(0, 2));
    expect(head.hasMore).toBe(true);
    expect(head.syncCursor).toBe(2);
    const tail = await listReceiveAddresses(gatewayDb(), owner, 'testnet', head.syncCursor, 2);
    expect(tail.addresses.map((row) => [row.derivationIndex, row.address])).toEqual([
      [3, must(handed[2])],
      [4, must(handed[3])],
    ]);
    expect(tail.hasMore).toBe(false);
    expect(tail.syncCursor).toBe(4);
  });
});
