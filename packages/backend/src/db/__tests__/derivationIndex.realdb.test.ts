import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { isCheckViolation, isUniqueViolation, sqlStateOf } from '@oxy.so/db';
import { reserveNextDerivationIndex } from '../merchants/derivationIndex';
import { merchants } from '../schema';
import { MAX_DERIVATION_INDEX } from '../schema/valueSets';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

/**
 * The reservation that decides which address a payer sends money to.
 *
 * Everything here is against a REAL Postgres server, because every property it
 * pins is one only a server has: a row lock, a `RETURNING` of a pre-increment
 * value, a CHECK, and the driver's own decoding of an `int4`. A mocked
 * `db.update()` accepts any statement and would pass all of it.
 */

/** Postgres `numeric_value_out_of_range` — what an `int4` overflow raises. */
const NUMERIC_VALUE_OUT_OF_RANGE = '22003';

let suite: SuiteDatabase | undefined;

async function insertMerchant(overrides: Partial<typeof merchants.$inferInsert> = {}) {
  // The WHOLE uuid in every unique value. A uuid v7's leading characters are
  // its millisecond timestamp, so two ids minted in the same millisecond share
  // any short prefix — a truncated fixture collides on `public_id` and reads as
  // a failure of the code under test.
  const id = uuidv7();
  await suite!.db.insert(merchants).values({
    id,
    publicId: `merch_${id}`,
    oxyAppId: `app_${id}`,
    environment: 'development',
    network: 'testnet',
    xpub: 'xpub-watch-only-fixture',
    ...overrides,
  });
  return id;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('merchant derivation-index reservation', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  it('returns the PRE-increment index and advances the counter', async () => {
    const merchantId = await insertMerchant();

    const reserved = await reserveNextDerivationIndex(suite!.db, merchantId);

    expect(reserved).not.toBeNull();
    expect(reserved?.index).toBe(0);
    expect(reserved?.xpub).toBe('xpub-watch-only-fixture');
    expect(reserved?.network).toBe('testnet');

    const [row] = await suite!.db
      .select({ next: merchants.nextDerivationIndex })
      .from(merchants)
      .where(eq(merchants.id, merchantId));
    expect(row?.next).toBe(1);
  });

  /**
   * TWO reservations, not one.
   *
   * A single reservation cannot tell a `number` from a `string`: `0` and `"0"`
   * both print as `0` and both pass `toBe(0)`'s coercion-free check only by
   * accident of the first value. The second reservation is what separates them
   * — a numeric column yields `1`, a string column yields `"1"` on read but
   * `"01"` the moment anything adds to it. That is the exact shape of the bug
   * this suite exists to prevent: a derived address one index away from the one
   * the payer was shown.
   */
  it('hands out consecutive indices as NUMBERS, never strings', async () => {
    const merchantId = await insertMerchant();

    const first = await reserveNextDerivationIndex(suite!.db, merchantId);
    const second = await reserveNextDerivationIndex(suite!.db, merchantId);
    const third = await reserveNextDerivationIndex(suite!.db, merchantId);

    expect([first?.index, second?.index, third?.index]).toEqual([0, 1, 2]);
    expect(typeof first?.index).toBe('number');
    expect(typeof second?.index).toBe('number');

    // The concatenation the wrong column type produces, written out so the
    // assertion names the failure rather than just its absence.
    expect(`${String(first?.index)}${String(1)}`).toBe('01');
    expect(second?.index).not.toBe('01' as unknown as number);
  });

  /**
   * Concurrency, against the real row lock.
   *
   * Sixteen reservations issued without awaiting in between. A
   * read-modify-write returns duplicates here; `UPDATE … SET x = x + 1` cannot,
   * because each statement waits on the row the previous one holds. The
   * assertion is on the SET of indices, so a repeat fails whichever pair
   * collides.
   */
  it('never hands the same index to two concurrent callers', async () => {
    const merchantId = await insertMerchant();
    const concurrency = 16;

    const results = await Promise.all(
      Array.from({ length: concurrency }, () => reserveNextDerivationIndex(suite!.db, merchantId))
    );
    const indices = results.map((result) => result?.index);

    expect(new Set(indices).size).toBe(concurrency);
    expect([...indices].sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: concurrency }, (_unused, offset) => offset)
    );

    const [row] = await suite!.db
      .select({ next: merchants.nextDerivationIndex })
      .from(merchants)
      .where(eq(merchants.id, merchantId));
    expect(row?.next).toBe(concurrency);
  });

  it('reserves nothing and returns null for an unknown merchant', async () => {
    expect(await reserveNextDerivationIndex(suite!.db, uuidv7())).toBeNull();
  });

  /**
   * `int4` is the BIP32 domain, and reaching its ceiling REFUSES rather than
   * wrapping. A wrap would silently re-issue index 0 — an address that already
   * has a payment on it.
   */
  it('refuses to advance past the int4 ceiling instead of wrapping', async () => {
    const merchantId = await insertMerchant({ nextDerivationIndex: MAX_DERIVATION_INDEX });

    let raised: unknown;
    try {
      await reserveNextDerivationIndex(suite!.db, merchantId);
    } catch (error) {
      raised = error;
    }

    // `sqlStateOf`, not the message. drizzle wraps the driver failure, so
    // `String(error)` prints only drizzle's own "Failed query: …" line — the
    // Postgres message, SQLSTATE and constraint name all live on `cause`. An
    // assertion on the rendered string reads as a WRONG ERROR here, and would
    // read as a passing check anywhere the wrapper text happened to match.
    expect(sqlStateOf(raised)).toBe(NUMERIC_VALUE_OUT_OF_RANGE);

    const [row] = await suite!.db
      .select({ next: merchants.nextDerivationIndex })
      .from(merchants)
      .where(eq(merchants.id, merchantId));
    expect(row?.next).toBe(MAX_DERIVATION_INDEX);
  });

  it('refuses a negative counter', async () => {
    let raised: unknown;
    try {
      await insertMerchant({ nextDerivationIndex: -1 });
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'merchants_next_derivation_index_check')).toBe(true);
  });

  it('refuses a second merchant for the same app and environment', async () => {
    const oxyAppId = `app_${uuidv7()}`;
    await insertMerchant({ oxyAppId, environment: 'production' });

    let raised: unknown;
    try {
      await insertMerchant({ oxyAppId, environment: 'production' });
    } catch (error) {
      raised = error;
    }
    expect(isUniqueViolation(raised, 'merchants_oxy_app_id_environment_key')).toBe(true);
  });

  /**
   * The reservation restamps `updated_at`. Asserted because the column's
   * `$onUpdate` fires on `db.update()` and NOT on a raw statement — so if this
   * repository is ever rewritten as `db.execute(sql\`update …\`)`, the counter
   * would still advance while the row's modification time froze.
   */
  it('restamps updated_at', async () => {
    const merchantId = await insertMerchant();
    const [before] = await suite!.db
      .select({ updatedAt: merchants.updatedAt })
      .from(merchants)
      .where(eq(merchants.id, merchantId));

    await Bun.sleep(5);
    await reserveNextDerivationIndex(suite!.db, merchantId);

    const [after] = await suite!.db
      .select({ updatedAt: merchants.updatedAt })
      .from(merchants)
      .where(eq(merchants.id, merchantId));

    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  /**
   * Vacuity floor. Every assertion above runs against tables this suite
   * believes the migration created; if it created none, an empty-schema run
   * would fail on the first insert — but a run against a database migrated by
   * something else could pass while testing the wrong schema.
   */
  it('runs against the migrated schema, not an empty database', async () => {
    const rows = await suite!.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
    );
    const names = rows.map((row) => String(row.table_name)).sort();
    expect(names).toEqual([
      'checkout_sessions',
      'connected_accounts',
      'disputes',
      'merchants',
      'payment_intents',
      'payment_links',
      'provider_events',
      'refunds',
      'social_receive_cursors',
      'social_send_attributions',
      'transfers',
      'webhook_deliveries',
    ]);
  });
});
