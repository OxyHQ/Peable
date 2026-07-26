import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import { findWalletXpub, upsertWalletXpub } from '../wallets/xpubRepository';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

const XPUB =
  'DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn';
const OTHER_XPUB =
  'DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZm';

let suite: SuiteDatabase | undefined;

beforeAll(async () => {
  if (!POSTGRES_TESTS_ENABLED) return;
  suite = await createSuiteDatabase();
});

afterAll(async () => {
  if (suite) await dropSuiteDatabase(suite);
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('walletXpubs', () => {
  it('returns null for a user who has never published one', async () => {
    expect(await findWalletXpub(suite!.db, uuidv7(), 'testnet')).toBeNull();
  });

  it('stores a published key and reads it back', async () => {
    const user = uuidv7();
    await upsertWalletXpub(suite!.db, { oxyUserId: user, network: 'testnet', xpub: XPUB });
    expect(await findWalletXpub(suite!.db, user, 'testnet')).toBe(XPUB);
  });

  /**
   * A device re-publishing must REPLACE, not accumulate. Two rows for one
   * (user, network) would leave readers picking one arbitrarily, and a browser
   * that picked the stale one would render a wallet whose addresses the phone
   * had already moved past — a wrong balance that looks authoritative.
   */
  it('replaces the previous key rather than accumulating a second row', async () => {
    const user = uuidv7();
    await upsertWalletXpub(suite!.db, { oxyUserId: user, network: 'testnet', xpub: XPUB });
    await upsertWalletXpub(suite!.db, { oxyUserId: user, network: 'testnet', xpub: OTHER_XPUB });
    expect(await findWalletXpub(suite!.db, user, 'testnet')).toBe(OTHER_XPUB);
  });

  /**
   * mainnet and testnet are different chains with different key material.
   * Answering one with the other's key derives addresses on a chain the user
   * never funded.
   */
  it('keeps the two networks apart', async () => {
    const user = uuidv7();
    await upsertWalletXpub(suite!.db, { oxyUserId: user, network: 'testnet', xpub: XPUB });
    expect(await findWalletXpub(suite!.db, user, 'mainnet')).toBeNull();
  });
});
