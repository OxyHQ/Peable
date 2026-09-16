import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxy.so/db';
import {
  readReservedThrough,
  reserveNextSocialReceiveIndex,
} from '../social/receiveCursor';
import { SOCIAL_RECEIVE_FIRST_FRESH_INDEX, socialReceiveCursors } from '../schema';
import { SOCIAL_RECEIVE_FIRST_FRESH_INDEX as SERVICE_FIRST_FRESH_INDEX } from '../../services/socialReceive';

/** Two identity public keys, as hex — the cursor stores whatever it is given. */
const KEY_A = '02' + 'aa'.repeat(32);
const KEY_B = '02' + 'bb'.repeat(32);
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

let suite: SuiteDatabase | undefined;

async function nextIndex(oxyUserId: string): Promise<number | undefined> {
  const [row] = await suite!.db
    .select({ next: socialReceiveCursors.nextDerivationIndex })
    .from(socialReceiveCursors)
    .where(
      and(
        eq(socialReceiveCursors.oxyUserId, oxyUserId),
        eq(socialReceiveCursors.network, 'testnet')
      )
    );
  return row?.next;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('social receive cursor reservation', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  /**
   * The schema's floor and the service's constant are the same number, and
   * neither can import the other into a CHECK. This is the seam where they are
   * held together; without it the constraint and the code could disagree by one
   * and only a production write would say so.
   */
  it('agrees with the service on the first fresh index', () => {
    expect(SOCIAL_RECEIVE_FIRST_FRESH_INDEX).toBe(SERVICE_FIRST_FRESH_INDEX);
    expect(SOCIAL_RECEIVE_FIRST_FRESH_INDEX).toBe(1);
  });

  it('creates the cursor on first use and hands out the first fresh index', async () => {
    const oxyUserId = uuidv7();

    const reserved = await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);

    expect(reserved).toBe(SOCIAL_RECEIVE_FIRST_FRESH_INDEX);
    expect(typeof reserved).toBe('number');
    // The row already records the NEXT one — the create and the first
    // reservation are the same statement.
    expect(await nextIndex(oxyUserId)).toBe(SOCIAL_RECEIVE_FIRST_FRESH_INDEX + 1);
  });

  /** Two reservations, for the reason spelled out in `derivationIndex.realdb.test.ts`. */
  it('hands out consecutive indices as NUMBERS across the create and update branches', async () => {
    const oxyUserId = uuidv7();

    const first = await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);
    const second = await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);
    const third = await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);

    expect([first, second, third]).toEqual([1, 2, 3]);
    expect(typeof second).toBe('number');
  });

  /**
   * Two concurrent FIRST payments — the race the lazy create exists for. One
   * insert wins, the other takes the `DO UPDATE` branch, and they get distinct
   * indices. A create-then-increment pair would either raise a duplicate key or
   * hand both callers the same index depending on the interleaving.
   */
  it('never hands the same index to two concurrent first payments', async () => {
    const oxyUserId = uuidv7();
    const concurrency = 12;

    const reserved = await Promise.all(
      Array.from({ length: concurrency }, () =>
        reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A)
      )
    );

    expect(new Set(reserved).size).toBe(concurrency);
    expect([...reserved].sort((a, b) => a - b)).toEqual(
      Array.from({ length: concurrency }, (_unused, offset) => offset + SOCIAL_RECEIVE_FIRST_FRESH_INDEX)
    );
    expect(await nextIndex(oxyUserId)).toBe(concurrency + SOCIAL_RECEIVE_FIRST_FRESH_INDEX);
  });

  /** One counter per network. Mainnet and testnet reservations must not share a sequence. */
  it('keeps a separate counter per network', async () => {
    const oxyUserId = uuidv7();

    await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);
    await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);
    const mainnetFirst = await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'mainnet', KEY_A);

    expect(mainnetFirst).toBe(SOCIAL_RECEIVE_FIRST_FRESH_INDEX);
  });

  it('reads back the highest index reserved, without reserving another', async () => {
    const oxyUserId = uuidv7();

    expect((await readReservedThrough(suite!.db, oxyUserId, 'testnet')).reservedThrough).toBe(
      SOCIAL_RECEIVE_FIRST_FRESH_INDEX - 1
    );

    await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);
    await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);

    expect((await readReservedThrough(suite!.db, oxyUserId, 'testnet')).reservedThrough).toBe(
      2
    );
    // Reading did not advance anything.
    expect((await readReservedThrough(suite!.db, oxyUserId, 'testnet')).reservedThrough).toBe(
      2
    );
    expect(await nextIndex(oxyUserId)).toBe(3);
  });

  it('refuses a second cursor for the same user and network', async () => {
    const oxyUserId = uuidv7();
    await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);

    let raised: unknown;
    try {
      await suite!.db
        .insert(socialReceiveCursors)
        .values({ id: uuidv7(), oxyUserId, network: 'testnet', identityPublicKey: KEY_A });
    } catch (error) {
      raised = error;
    }
    expect(isUniqueViolation(raised, 'social_receive_cursors_oxy_user_id_network_key')).toBe(true);
  });

  /**
   * Index 0 is the recipient's on-device default address. A cursor pointing at
   * it would hand it out as if it belonged to one payment relationship.
   */
  it('refuses a cursor below the first fresh index', async () => {
    let raised: unknown;
    try {
      await suite!.db.insert(socialReceiveCursors).values({
        id: uuidv7(),
        oxyUserId: uuidv7(),
        network: 'testnet',
        identityPublicKey: KEY_A,
        nextDerivationIndex: 0,
      });
    } catch (error) {
      raised = error;
    }
    expect(
      isCheckViolation(raised, 'social_receive_cursors_next_derivation_index_check')
    ).toBe(true);
  });

  it('refuses a network outside the closed set', async () => {
    let raised: unknown;
    try {
      await suite!.db.insert(socialReceiveCursors).values({
        id: uuidv7(),
        oxyUserId: uuidv7(),
        network: 'regtest',
        identityPublicKey: KEY_A,
      });
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'social_receive_cursors_network_check')).toBe(true);
  });
  /**
   * The address is a function of the identity key, so the cursor has to say
   * which key produced it. Without that, a device asking "how far should I
   * watch?" gets a number and no way to tell whether it is watching the right
   * tree at all.
   */
  it('records the identity key the addresses were derived from', async () => {
    const oxyUserId = uuidv7();

    await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);

    expect((await readReservedThrough(suite!.db, oxyUserId, 'testnet')).identityPublicKey).toBe(
      KEY_A
    );
  });

  it('follows the key the latest reservation used', async () => {
    const oxyUserId = uuidv7();

    await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_A);
    const second = await reserveNextSocialReceiveIndex(suite!.db, oxyUserId, 'testnet', KEY_B);

    // The counter is untouched by the key changing: it counts addresses.
    expect(second).toBe(SOCIAL_RECEIVE_FIRST_FRESH_INDEX + 1);
    expect((await readReservedThrough(suite!.db, oxyUserId, 'testnet')).identityPublicKey).toBe(
      KEY_B
    );
  });

  it('reports no key for a user who has never had an address reserved', async () => {
    expect((await readReservedThrough(suite!.db, uuidv7(), 'testnet')).identityPublicKey).toBeNull();
  });
});
