import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { must } from '../../__tests__/helpers/must';
import { HDKey } from '@scure/bip32';
import { TESTNET, deriveKeyFromSeed, mnemonicToSeed } from '@fairco.in/core';
import { uuidv7 } from '@oxy.so/db';
import {
  findEndpointForMerchant,
  findEndpointSigningTarget,
  insertEndpoint,
} from '../webhooks/webhookEndpointRepository';
import {
  WatchOnlyViolationError,
  findMerchantByAppEnvironment,
  findMerchantById,
  findMerchantsByIds,
  insertMerchant,
  updateMerchantSettings,
} from '../merchants/merchantRepository';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

/**
 * The merchant repository, and in particular the ONE guarantee that does not
 * survive the port by itself.
 */

/** The canonical all-"abandon" + "art" testnet vector, as `services/__tests__/derivation.test.ts` uses. */
const XPUB =
  'DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn';
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

/** The matching PRIVATE extended key — what a merchant must never be able to register. */
function privateExtendedKey(): string {
  const root = deriveKeyFromSeed(mnemonicToSeed(MNEMONIC), TESTNET);
  return root.derive(`m/44'/${TESTNET.bip44CoinType}'/0'`).hdKey.privateExtendedKey;
}

let suite: SuiteDatabase | undefined;

function registration(overrides: Partial<Parameters<typeof insertMerchant>[1]> = {}) {
  const unique = uuidv7();
  return {
    oxyAppId: `app_${unique}`,
    environment: 'development' as const,
    network: 'testnet' as const,
    xpub: XPUB,
    publicId: `merch_${unique}`,
    ...overrides,
  };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('merchant repository', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  it('registers a merchant and reads it back by app and environment', async () => {
    const params = registration();
    const created = await insertMerchant(must(suite).db, params);

    expect(created?.publicId).toBe(params.publicId);
    expect(created?.network).toBe('testnet');
    // Column defaults, not caller input.
    expect(created?.requiredConfirmations).toBe(1);
    expect(created?.livemode).toBe(false);

    const found = await findMerchantByAppEnvironment(
      must(suite).db,
      params.oxyAppId,
      'development',
    );
    expect(found?.id).toBe(must(created).id);
  });

  /**
   * THE test this file exists for.
   *
   * `models/Merchant.ts` enforces the non-custody firewall in a
   * `pre('validate')` hook that runs on every save. A drizzle schema has no
   * hooks, and no CHECK constraint can express it — deciding it requires
   * deriving a secp256k1 child key. So the guarantee moved into
   * `insertMerchant`, and NOTHING fails if someone removes it there: every
   * other test in this repository hands in a valid xpub and would stay green.
   *
   * Only a test that presents a real PRIVATE extended key can tell the two
   * apart, which is why this one builds one rather than asserting on a string.
   */
  it('refuses a private extended key, and stores nothing', async () => {
    const xprv = privateExtendedKey();

    // Vacuity guard: prove the fixture really is a private key before using it
    // to prove anything. A malformed string would be refused too, for a reason
    // that has nothing to do with the firewall.
    const parsed = HDKey.fromExtendedKey(xprv, {
      public: TESTNET.bip32.public,
      private: TESTNET.bip32.private,
    });
    expect(parsed.privateKey).not.toBeNull();

    const params = registration({ xpub: xprv });
    let raised: unknown;
    try {
      await insertMerchant(must(suite).db, params);
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(WatchOnlyViolationError);
    // Refused BEFORE the insert — a row would mean the gateway had persisted a
    // spending key, which is the exact outcome the firewall exists to prevent.
    expect(
      await findMerchantByAppEnvironment(must(suite).db, params.oxyAppId, 'development'),
    ).toBeNull();
  });

  it('converges on the unique index rather than reading first', async () => {
    const first = registration();
    expect(await insertMerchant(must(suite).db, first)).not.toBeNull();

    const second = await insertMerchant(
      must(suite).db,
      registration({ oxyAppId: first.oxyAppId, environment: 'development' }),
    );
    expect(second).toBeNull();
  });

  /** The same app in a DIFFERENT environment is a different merchant — the test/live split. */
  it('allows one merchant per environment for the same application', async () => {
    const dev = registration();
    await insertMerchant(must(suite).db, dev);
    const staging = await insertMerchant(
      must(suite).db,
      registration({ oxyAppId: dev.oxyAppId, environment: 'staging' }),
    );
    expect(staging).not.toBeNull();
    expect(staging?.id).not.toBe(
      (await findMerchantByAppEnvironment(must(suite).db, dev.oxyAppId, 'development'))?.id,
    );
  });

  it('patches only the mutable fields and leaves the rest alone', async () => {
    const created = await insertMerchant(must(suite).db, registration());
    const patched = await updateMerchantSettings(must(suite).db, must(created).id, {
      displayName: 'Merchant Example',
      requiredConfirmations: 6,
    });

    expect(patched?.displayName).toBe('Merchant Example');
    expect(patched?.requiredConfirmations).toBe(6);
    // Untouched by a patch that did not mention them.
    expect(patched?.xpub).toBe(XPUB);
    expect(patched?.network).toBe('testnet');
    expect(patched?.environment).toBe('development');
  });

  it('clears a field with an explicit null, and ignores an absent field', async () => {
    const created = await insertMerchant(
      must(suite).db,
      registration({ description: 'A shop that sells things' }),
    );

    // Absent means "change nothing" — NOT "set to null". The two are different
    // requests and the API distinguishes them, so the repository must too.
    const untouched = await updateMerchantSettings(must(suite).db, must(created).id, {
      requiredConfirmations: 2,
    });
    expect(untouched?.description).toBe('A shop that sells things');

    const cleared = await updateMerchantSettings(must(suite).db, must(created).id, {
      description: null,
    });
    expect(cleared?.description).toBeNull();
  });

  it('treats an empty patch as a no-op read rather than a failed update', async () => {
    const created = await insertMerchant(must(suite).db, registration());
    const result = await updateMerchantSettings(must(suite).db, must(created).id, {});
    expect(result?.id).toBe(must(created).id);
    expect(result?.updatedAt.getTime()).toBe(must(created).updatedAt.getTime());
  });

  /**
   * A webhook endpoint's signing secret is loaded by exactly one function, and
   * never by an ordinary read. `WebhookEndpointRow` has no `secret` property at
   * all, so a serializer reaching for one fails `tsc` rather than publishing it.
   */
  it('loads an endpoint secret only through the delivery-path read', async () => {
    const created = must(await insertMerchant(must(suite).db, registration()));
    const endpoint = await insertEndpoint(must(suite).db, {
      publicId: 'we_secret_read',
      merchantId: created.id,
      url: 'https://merchant.example/hook',
      enabledEvents: ['*'],
      metadata: {},
      apiVersion: '2026-11-03',
      secret: 'whsec_only_the_dispatcher_reads_this',
    });
    if (endpoint === 'limit_reached') throw new Error('unexpected limit');

    expect(await findEndpointSigningTarget(must(suite).db, endpoint.id)).toEqual({
      url: 'https://merchant.example/hook',
      status: 'enabled',
      secrets: ['whsec_only_the_dispatcher_reads_this'],
      livemode: created.livemode,
      firstParty: false,
    });
    const read = await findEndpointForMerchant(must(suite).db, 'we_secret_read', created.id);
    expect(Object.keys(read ?? {})).not.toContain('secret');
    expect(Object.keys(read ?? {})).not.toContain('previousSecret');
  });

  /**
   * The batch read address enrichment uses. It resolves up to 50 addresses to
   * their intents and then to the merchants behind them; one query per address
   * would be an N+1 on a path a wallet calls to render a transaction list.
   *
   * The fixture that discriminates is `uninvolved` — a merchant nobody asked
   * for. Without it, a read whose WHERE clause was dropped altogether returns a
   * superset containing both requested merchants and passes every other
   * assertion here.
   */
  it('reads several merchants in one query, and no others', async () => {
    const one = must(await insertMerchant(must(suite).db, registration()));
    const two = must(await insertMerchant(must(suite).db, registration()));
    const uninvolved = must(await insertMerchant(must(suite).db, registration()));

    const found = await findMerchantsByIds(must(suite).db, [one.id, two.id, uuidv7()]);
    expect(found.map((row) => row.id).sort()).toEqual([one.id, two.id].sort());
    expect(found.map((row) => row.id)).not.toContain(uninvolved.id);
    // The derivation counter must not ride along on a read that feeds a public
    // enrichment DTO — `MERCHANT_COLUMNS` is the guard.
    expect(found.every((row) => !('nextDerivationIndex' in row))).toBe(true);
    // The empty input answers empty. This pins the BEHAVIOUR, not the guard
    // that produces it: on drizzle-orm 0.45.2 `inArray(col, [])` renders
    // `where false`, so removing the short-circuit changes nothing observable
    // and this assertion holds either way. Verified by a mutation that removed
    // it and left the suite green — reported here rather than dressed up as a
    // check it is not.
    expect(await findMerchantsByIds(must(suite).db, [])).toEqual([]);
  });

  it('returns null for an unknown merchant rather than throwing', async () => {
    expect(await findMerchantById(must(suite).db, uuidv7())).toBeNull();
    expect(
      await updateMerchantSettings(must(suite).db, uuidv7(), { requiredConfirmations: 3 }),
    ).toBeNull();
  });
});
