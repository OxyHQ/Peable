import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { merchants } from '../../db/schema';
import { reserveNextAddress } from '../reserveAddress';
import {
  gatewayDb,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

/**
 * RESCUED from `models/__tests__/models.test.ts`, which the Mongo→Postgres
 * switch deleted along with the models it tested.
 *
 * This one was never a model test either, and losing it would have been the
 * most expensive omission in the switch: `reserveNextAddress` decides which
 * address a payer sends real money to. `db/__tests__/derivationIndex.realdb.test.ts`
 * covers the INDEX reservation underneath it — that the counter is claimed
 * atomically — but nothing else covers the DERIVATION built on top, i.e. that
 * index N actually turns into the address the merchant's own wallet will scan.
 *
 * The addresses below are pinned literals, deliberately. A test that only
 * asserted "three distinct addresses" would pass just as happily against a
 * derivation that had silently changed path, network or index base, and the
 * failure mode of that is funds at an address nobody can spend from.
 *
 * The xpub is the harness default, which is derived from the canonical
 * all-"abandon" + "art" mnemonic at `m/44'/1'/0'` — verified byte-identical to
 * the literal these addresses were originally pinned against.
 */

useGatewayDatabase();

test('reserveNextAddress claims monotonically increasing indexes with distinct addresses', async () => {
  const merchant = await seedMerchant({
    publicId: 'merch_test0000000000000003',
    oxyAppId: 'app_reserve_addresses',
    environment: 'development',
    network: 'testnet',
  });

  const first = await reserveNextAddress(merchant.id);
  const second = await reserveNextAddress(merchant.id);
  const third = await reserveNextAddress(merchant.id);

  expect(first).toEqual({ index: 0, address: 'TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3' });
  expect(second).toEqual({ index: 1, address: 'TVdQEadb9Yurh3QCBf1vwjZxNySQvHxFmk' });
  expect(third).toEqual({ index: 2, address: 'TRhbVij2oTwETnzpVNDixacseS48FZgsUZ' });

  const addresses = new Set([first.address, second.address, third.address]);
  expect(addresses.size).toBe(3);

  // `next_derivation_index` is not on `MerchantRow` — no repository read
  // exposes it, because nothing in production needs to read it without also
  // claiming it. Read the column directly to assert the counter advanced.
  const [reloaded] = await gatewayDb()
    .select({ nextDerivationIndex: merchants.nextDerivationIndex })
    .from(merchants)
    .where(eq(merchants.id, merchant.id));
  expect(reloaded?.nextDerivationIndex).toBe(3);
});
