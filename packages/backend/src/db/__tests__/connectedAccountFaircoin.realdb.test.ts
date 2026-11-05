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
import { deriveSocialReceiveAddress, getNetwork } from '@fairco.in/core';
import { sqlStateOf, uuidv7 } from '@oxy.so/db';
import { must } from '../../__tests__/helpers/must';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { testIdentityPublicKey } from '../../__tests__/setup/identityKeys';
import {
  FaircoinWalletMissingError,
  faircoinRecipientOf,
  reserveFaircoinAddress,
} from '../../services/faircoin/recipient';
import {
  confirmFaircoinHalf,
  insertConnectedAccount,
  type ConnectedAccountRow,
} from '../accounts/connectedAccountRepository';
import { insertMerchant, type MerchantRow } from '../merchants/merchantRepository';
import { insertPaymentIntent } from '../payments/paymentIntentRepository';
import { connectedAccounts } from '../schema';

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/** A platform with no FairCoin of its own in play — Mercaria's shape. */
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
    status: 'requires_action' as const,
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

    it('refuses a confirmation with no FairCoin half', async () => {
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
            faircoinRegisteredAt: new Date(),
          }),
      );
      expect(sqlStateOf(error)).toBe(CHECK_VIOLATION);
    });
  });

  describe('the seller confirms — the single writer (ADR 0021 D5)', () => {
    it('confirms once, stores no key, and never twice', async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id);
      const first = await confirmFaircoinHalf(gatewayDb(), seller.id);
      expect(first.ok).toBe(true);
      expect(await confirmFaircoinHalf(gatewayDb(), seller.id)).toEqual({
        ok: false,
        refusal: 'already_registered',
      });
    });

    it('refuses a seller with no FairCoin half', async () => {
      const platform = await seedCardOnlyPlatform();
      const id = uuidv7();
      const card = must(
        await insertConnectedAccount(gatewayDb(), {
          publicId: `ca_${id}`,
          merchantId: platform.id,
          externalRef: `store_${id}`,
          provider: 'stripe',
          providerAccountId: `acct_${id}`,
          country: 'ES',
        }),
      );
      expect(await confirmFaircoinHalf(gatewayDb(), card.id)).toEqual({
        ok: false,
        refusal: 'no_faircoin_half',
      });
    });
  });

  describe("the seller's reservation — the seller's own Peable wallet", () => {
    /**
     * Two CONSECUTIVE reservations, for the reason AGENTS.md gives: one cannot
     * tell the number 1 from a string that prints the same, and a string makes
     * `index + 1` concatenation. On the SELLER's identity cursor (ADR 0002).
     */
    it("hands out two distinct addresses of the seller's own tree", async () => {
      const platform = await seedCardOnlyPlatform();
      const seller = await seedFaircoinSeller(platform.id, { oxyUserId: `user_${uuidv7()}` });
      const recipient = must(faircoinRecipientOf(platform, seller));
      expect(recipient).toBe(must(seller.faircoinOxyUserId));
      const first = await reserveFaircoinAddress(recipient, 'testnet');
      const second = await reserveFaircoinAddress(recipient, 'testnet');
      const key = testIdentityPublicKey(recipient);
      const network = getNetwork('testnet');
      expect(first.address).toBe(deriveSocialReceiveAddress(key, 1, network));
      expect(second.address).toBe(deriveSocialReceiveAddress(key, 2, network));
      expect(first.recipientAccountId).toBe(recipient);
    });

    it('reserves nothing for a seller whose account has no Peable wallet', async () => {
      const error = await caught(() => reserveFaircoinAddress('keyless_seller', 'testnet'));
      expect(error).toBeInstanceOf(FaircoinWalletMissingError);
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
