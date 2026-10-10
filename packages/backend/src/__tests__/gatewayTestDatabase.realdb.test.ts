import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { merchants, paymentIntents } from '../db/schema';
import { WatchOnlyViolationError } from '../db/merchants/merchantRepository';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedAttribution,
  seedDelivery,
  seedIntent,
  seedLink,
  seedMerchant,
  seedSession,
  testXpubFor,
  useGatewayDatabase,
} from './helpers/gatewayTestDatabase';

/**
 * The harness twenty suites are about to depend on.
 *
 * Tested before anything uses it, because a broken seed helper does not fail
 * loudly in the suites that call it — it produces slightly wrong state and
 * their assertions drift with it. This is the one file where the helper is the
 * SUBJECT rather than the scaffolding.
 */

/**
 * The derived xpub must reproduce the vector `services/__tests__/derivation.test.ts`
 * has asserted addresses against since before this port. That constant is an
 * independently-known good value, so matching it proves `testXpubFor` derives
 * the same key the rest of the repository already trusts — rather than merely
 * deriving something self-consistent. No database needed, so it runs everywhere.
 */
describe('the derived test xpub', () => {
  const CANONICAL_TESTNET_XPUB =
    'DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn';

  it('reproduces the canonical testnet vector', () => {
    expect(testXpubFor('testnet')).toBe(CANONICAL_TESTNET_XPUB);
  });

  it('derives a DIFFERENT key for mainnet', () => {
    // Not merely different text: a testnet xpub is refused outright for a
    // mainnet merchant, which is why the harness derives per network.
    expect(testXpubFor('mainnet')).not.toBe(CANONICAL_TESTNET_XPUB);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the gateway test harness', () => {
  useGatewayDatabase();

  it('gives the suite a live, migrated database', async () => {
    const rows = await gatewayDb().select().from(merchants);
    expect(rows).toEqual([]);
  });

  it('seeds a whole gateway graph from defaults alone', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant);
    const link = await seedLink(merchant);
    const session = await seedSession(merchant, intent);
    const delivery = await seedDelivery(merchant, intent);
    const attribution = await seedAttribution();

    expect(merchant.network).toBe('testnet');
    expect(intent.merchantId).toBe(merchant.id);
    expect(link.oxyAppId).toBe(merchant.oxyAppId);
    expect(session.paymentIntentId).toBe(intent.id);
    expect(delivery.merchantId).toBe(merchant.id);
    // 1, not 0 — index 0 is the recipient's default address and the CHECK
    // refuses it, so a zero default would make every seeded attribution fail.
    expect(attribution.derivationIndex).toBe(1);
  });

  /**
   * Defaults must not collide. Twenty suites seeding repeatedly is exactly
   * where a fixed default id turns into a duplicate-key failure that reads like
   * a bug in the code under test.
   */
  it('produces distinct rows when called repeatedly with no arguments', async () => {
    const merchants_ = [await seedMerchant(), await seedMerchant(), await seedMerchant()];
    expect(new Set(merchants_.map((row) => row.publicId)).size).toBe(3);
    expect(new Set(merchants_.map((row) => row.oxyAppId)).size).toBe(3);

    const merchant = merchants_[0]!;
    const intents = [await seedIntent(merchant), await seedIntent(merchant)];
    expect(new Set(intents.map((row) => row.address)).size).toBe(2);
    expect(new Set(intents.map((row) => row.publicId)).size).toBe(2);
  });

  /** A caller's values win over every default — the property the switch depends on. */
  it('honours supplied values exactly', async () => {
    const merchant = await seedMerchant({
      publicId: 'merch_test_redeliver_1',
      oxyAppId: 'app_fixed',
      environment: 'production',
      network: 'mainnet',
      webhookUrl: 'https://merchant.example/hook',
      webhookSecret: 'whsec_redeliver',
      requiredConfirmations: 6,
    });

    expect(merchant.publicId).toBe('merch_test_redeliver_1');
    expect(merchant.oxyAppId).toBe('app_fixed');
    expect(merchant.environment).toBe('production');
    expect(merchant.network).toBe('mainnet');
    expect(merchant.webhookUrl).toBe('https://merchant.example/hook');
    expect(merchant.requiredConfirmations).toBe(6);
  });

  /**
   * An intent defaults to its MERCHANT's network, never a literal. A hard-coded
   * `testnet` here would make every mainnet-merchant suite fail on
   * `payment_intents_merchant_id_network_fkey` instead of on its subject —
   * which is why this is asserted rather than assumed.
   */
  it("defaults an intent to its merchant's network", async () => {
    const mainnet = await seedMerchant({ environment: 'production', network: 'mainnet' });
    const intent = await seedIntent(mainnet);
    expect(intent.network).toBe('mainnet');
  });

  /**
   * The seeds go through the repositories, so the non-custody firewall runs on
   * seeded data too. A harness that inserted rows directly would let a suite
   * create a merchant production would refuse.
   */
  it('applies the non-custody firewall to seeded merchants', async () => {
    let raised: unknown;
    try {
      await seedMerchant({ xpub: 'not-a-watch-only-key' });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(WatchOnlyViolationError);
  });

  it('empties every table on reset', async () => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant);
    await seedDelivery(merchant, intent);
    await seedSession(merchant, intent);
    await seedLink(merchant);
    await seedAttribution();

    await resetGatewayTables();

    expect(await gatewayDb().select().from(merchants)).toEqual([]);
    expect(await gatewayDb().select().from(paymentIntents)).toEqual([]);
  });

  /** After a reset the database is still usable — a truncate that broke the sequence would show here. */
  it('still seeds after a reset', async () => {
    await resetGatewayTables();
    const merchant = await seedMerchant();
    const found = await gatewayDb().select().from(merchants).where(eq(merchants.id, merchant.id));
    expect(found).toHaveLength(1);
  });
});
