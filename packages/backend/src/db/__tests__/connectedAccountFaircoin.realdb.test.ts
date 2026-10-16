/**
 * FairCoin connected accounts at the database (ADR 0012), against a REAL server.
 *
 * Every property pinned here is one only a server has — a row lock and a
 * pre-increment RETURNING, a CHECK, a composite foreign key over a GENERATED
 * column, a partial unique index — so a mocked `db.update()` would pass all of
 * it and prove nothing.
 */
import { describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { HDKey } from '@scure/bip32';
import { getNetwork } from '@fairco.in/core';
import { sqlStateOf, uuidv7 } from '@oxy.so/db';
import { must } from '../../__tests__/helpers/must';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  seedMerchant,
  testXprvFor,
  testXpubFor,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { deriveIntentAddress } from '../../services/derivation';
import { WatchOnlyViolationError } from '../../services/watchOnly';
import { reserveNextAccountDerivationIndex } from '../accounts/accountDerivationIndex';
import {
  insertConnectedAccount,
  registerFaircoinKey,
  type ConnectedAccountRow,
} from '../accounts/connectedAccountRepository';
import { insertMerchant, type MerchantRow } from '../merchants/merchantRepository';
import { insertPaymentIntent } from '../payments/paymentIntentRepository';
import { connectedAccounts } from '../schema';

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/** A CARD-ONLY platform — Mercaria's shape: no network, no xpub. */
async function seedCardOnlyPlatform(): Promise<MerchantRow> {
  const id = uuidv7();
  return must(
    await insertMerchant(gatewayDb(), {
      publicId: `merch_${id}`,
      oxyAppId: `app_${id}`,
      environment: 'development',
    }),
  );
}

async function seedFaircoinSeller(
  merchantId: string,
  values: { readonly network?: 'testnet' | 'mainnet'; readonly oxyUserId?: string } = {},
): Promise<ConnectedAccountRow> {
  const id = uuidv7();
  return must(
    await insertConnectedAccount(gatewayDb(), {
      publicId: `ca_${id}`,
      merchantId,
      externalRef: `store_${id}`,
      faircoin: {
        network: values.network ?? 'testnet',
        oxyUserId: values.oxyUserId ?? `user_${id}`,
      },
    }),
  );
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the statement to be refused');
}

function intentValues(merchantId: string, overrides: Record<string, unknown> = {}) {
  const id = uuidv7();
  return {
    publicId: `pi_${id}`,
    merchantId,
    rail: 'faircoin' as const,
    amount: '100000000',
    currency: 'FAIR' as const,
    network: 'testnet' as const,
    address: `addr_${id}`,
    provider: null,
    clientSecret: `pi_${id}_secret`,
    idempotencyKey: `idem_${id}`,
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
    ...overrides,
  };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('FairCoin connected accounts (database)', () => {
  useGatewayDatabase();

  describe('the row', () => {
    it('opens a FairCoin-only seller with no card half and no key', async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      expect(seller.provider).toBeNull();
      expect(seller.providerAccountId).toBeNull();
      expect(seller.country).toBeNull();
      expect(seller.network).toBe('testnet');
      expect(seller.faircoinRegisteredAt).toBeNull();
    });

    it('refuses a seller with neither half', async () => {
      const platform = await seedCardOnlyPlatform();
      const id = uuidv7();
      const error = await caught(() =>
        gatewayDb()
          .insert(connectedAccounts)
          .values({ id, publicId: `ca_${id}`, merchantId: platform.id, externalRef: `s_${id}` }),
      );
      expect(sqlStateOf(error)).toBe(CHECK_VIOLATION);
    });

    it('refuses half a card half', async () => {
      const platform = await seedCardOnlyPlatform();
      const id = uuidv7();
      const error = await caught(() =>
        gatewayDb()
          .insert(connectedAccounts)
          .values({
            id,
            publicId: `ca_${id}`,
            merchantId: platform.id,
            externalRef: `s_${id}`,
            provider: 'stripe',
            providerAccountId: `acct_${id}`,
            // no country
          }),
      );
      expect(sqlStateOf(error)).toBe(CHECK_VIOLATION);
    });

    it('refuses a key with no network', async () => {
      const platform = await seedCardOnlyPlatform();
      const id = uuidv7();
      const error = await caught(() =>
        gatewayDb()
          .insert(connectedAccounts)
          .values({
            id,
            publicId: `ca_${id}`,
            merchantId: platform.id,
            externalRef: `s_${id}`,
            provider: 'stripe',
            providerAccountId: `acct_${id}`,
            country: 'ES',
            xpub: testXpubFor('testnet', 9),
            faircoinRegisteredAt: new Date(),
          }),
      );
      expect(sqlStateOf(error)).toBe(CHECK_VIOLATION);
    });
  });

  describe('registering the key — the single writer', () => {
    it('stores a watch-only key once, and never replaces it', async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      const first = await registerFaircoinKey(gatewayDb(), seller.id, testXpubFor('testnet', 1));
      expect(first.ok).toBe(true);

      const second = await registerFaircoinKey(gatewayDb(), seller.id, testXpubFor('testnet', 2));
      expect(second).toEqual({ ok: false, refusal: 'already_registered' });

      const [row] = await gatewayDb()
        .select({ xpub: connectedAccounts.xpub })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, seller.id));
      expect(row?.xpub).toBe(testXpubFor('testnet', 1));
    });

    /**
     * THE non-custody firewall for sellers. A real PRIVATE extended key, proven
     * private, refused and never stored. Deleting the `assertWatchOnly` call in
     * `registerFaircoinKey` reds exactly this test.
     */
    it('refuses a private extended key and stores nothing', async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      const xprv = testXprvFor('testnet', 3);
      // Vacuity guard: prove the fixture really IS a private key, so the refusal
      // below is the firewall's and not a malformed string's.
      const network = getNetwork('testnet');
      const parsed = HDKey.fromExtendedKey(xprv, {
        public: network.bip32.public,
        private: network.bip32.private,
      });
      expect(parsed.privateKey).not.toBeNull();

      const error = await caught(() => registerFaircoinKey(gatewayDb(), seller.id, xprv));
      expect(error).toBeInstanceOf(WatchOnlyViolationError);

      const [row] = await gatewayDb()
        .select({ xpub: connectedAccounts.xpub })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, seller.id));
      expect(row?.xpub).toBeNull();
    });

    it("refuses a key for the other network than the account's", async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id, { network: 'testnet' });
      const error = await caught(() =>
        registerFaircoinKey(gatewayDb(), seller.id, testXpubFor('mainnet', 1)),
      );
      expect(error).toBeInstanceOf(WatchOnlyViolationError);
    });

    it("refuses another seller's key — two counters on one key collide", async () => {
      const platform = await seedCardOnlyPlatform();
      const a = await seedFaircoinSeller(platform.id);
      const b = await seedFaircoinSeller(platform.id);
      const key = testXpubFor('testnet', 4);
      expect((await registerFaircoinKey(gatewayDb(), a.id, key)).ok).toBe(true);
      expect(await registerFaircoinKey(gatewayDb(), b.id, key)).toEqual({
        ok: false,
        refusal: 'key_in_use',
      });
    });

    it("refuses a MERCHANT's key, for the same reason", async () => {
      const merchant = await seedMerchant({ xpub: testXpubFor('testnet', 5) });
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      expect(await registerFaircoinKey(gatewayDb(), seller.id, must(merchant.xpub))).toEqual({
        ok: false,
        refusal: 'key_in_use',
      });
    });
  });

  describe("the seller's reservation", () => {
    /**
     * Two CONSECUTIVE reservations, for the reason AGENTS.md gives: one cannot
     * tell the number 0 from a string that prints the same, and a string makes
     * `index + 1` concatenation.
     */
    it('hands out 0 then 1, as numbers, on the SELLER key', async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      const key = testXpubFor('testnet', 6);
      expect((await registerFaircoinKey(gatewayDb(), seller.id, key)).ok).toBe(true);

      const first = must(
        await reserveNextAccountDerivationIndex(gatewayDb(), platform.id, seller.id),
      );
      const second = must(
        await reserveNextAccountDerivationIndex(gatewayDb(), platform.id, seller.id),
      );
      expect(first.index).toBe(0);
      expect(second.index).toBe(1);
      expect(typeof first.index).toBe('number');
      expect(first.xpub).toBe(key);
      expect(first.network).toBe('testnet');
      expect(deriveIntentAddress(key, 0, second.index, getNetwork('testnet'))).not.toBe(
        deriveIntentAddress(key, 0, first.index, getNetwork('testnet')),
      );
    });

    it('reserves nothing for a seller with no key yet', async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      expect(
        await reserveNextAccountDerivationIndex(gatewayDb(), platform.id, seller.id),
      ).toBeNull();
      const [row] = await gatewayDb()
        .select({ next: connectedAccounts.nextDerivationIndex })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, seller.id));
      expect(row?.next).toBe(0);
    });

    it("never reserves on another platform's seller", async () => {
      const platform = await seedCardOnlyPlatform();
      const other = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      expect(
        (await registerFaircoinKey(gatewayDb(), seller.id, testXpubFor('testnet', 7))).ok,
      ).toBe(true);
      expect(await reserveNextAccountDerivationIndex(gatewayDb(), other.id, seller.id)).toBeNull();
    });
  });

  describe('the network firewall, moved (ADR 0012 D5)', () => {
    it('accepts an on-behalf intent for a card-only platform', async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      const row = await insertPaymentIntent(
        gatewayDb(),
        intentValues(platform.id, { connectedAccountId: seller.id }),
      );
      expect(row?.connectedAccountId).toBe(seller.id);
      expect(row?.connectedAccountPublicId).toBe(seller.publicId);
    });

    it("refuses an intent on another platform's seller", async () => {
      const platform = await seedCardOnlyPlatform();
      const other = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(other.id);
      const error = await caught(() =>
        insertPaymentIntent(
          gatewayDb(),
          intentValues(platform.id, { connectedAccountId: seller.id }),
        ),
      );
      expect(sqlStateOf(error)).toBe(FOREIGN_KEY_VIOLATION);
    });

    it("refuses an on-behalf intent on a network other than the seller's", async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id, { network: 'testnet' });
      const error = await caught(() =>
        insertPaymentIntent(
          gatewayDb(),
          intentValues(platform.id, { connectedAccountId: seller.id, network: 'mainnet' }),
        ),
      );
      expect(sqlStateOf(error)).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('refuses an on-behalf CARD intent', async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      const error = await caught(() =>
        insertPaymentIntent(
          gatewayDb(),
          intentValues(platform.id, {
            connectedAccountId: seller.id,
            rail: 'card',
            currency: 'EUR',
            network: null,
            address: null,
            provider: 'stripe',
          }),
        ),
      );
      expect(sqlStateOf(error)).toBe(CHECK_VIOLATION);
    });

    /**
     * The direct firewall still binds: the generated `merchant_network` is
     * `network` on every non-on-behalf row, so a merchant's own FairCoin intent
     * on the wrong chain is refused exactly as before.
     */
    it("still refuses a DIRECT intent on a network other than the merchant's", async () => {
      const merchant = await seedMerchant({ network: 'testnet' });
      const error = await caught(() =>
        insertPaymentIntent(gatewayDb(), intentValues(merchant.id, { network: 'mainnet' })),
      );
      expect(sqlStateOf(error)).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('still refuses a direct FairCoin intent for a card-only merchant', async () => {
      const platform = await seedCardOnlyPlatform();
      const error = await caught(() => insertPaymentIntent(gatewayDb(), intentValues(platform.id)));
      expect(sqlStateOf(error)).toBe(FOREIGN_KEY_VIOLATION);
    });

    it("freezes the seller's network once an intent exists", async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      must(
        await insertPaymentIntent(
          gatewayDb(),
          intentValues(platform.id, { connectedAccountId: seller.id }),
        ),
      );
      const error = await caught(() =>
        gatewayDb()
          .update(connectedAccounts)
          .set({ network: 'mainnet' })
          .where(eq(connectedAccounts.id, seller.id)),
      );
      expect(sqlStateOf(error)).toBe(FOREIGN_KEY_VIOLATION);
    });
  });
});
