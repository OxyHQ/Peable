import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { isCheckViolation, isForeignKeyViolation, uuidv7 } from '@oxy.so/db';
import {
  findIntentByIdForMerchant,
  findIntentByIdempotencyKey,
  findIntentById,
  findIntentByPublicId,
  findIntentForMerchant,
  findIntentsByAddresses,
  findWatchableIntents,
  insertPaymentIntent,
  listIntentsForMerchant,
  updateIntentState,
  type PaymentIntentRow,
} from '../payments/paymentIntentRepository';
import { insertMerchant } from '../merchants/merchantRepository';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

const XPUB =
  'DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn';

let suite: SuiteDatabase | undefined;

async function makeMerchant(network: 'testnet' | 'mainnet' = 'testnet') {
  const unique = uuidv7();
  const merchant = await insertMerchant(suite!.db, {
    oxyAppId: `app_${unique}`,
    // A mainnet merchant needs a production environment (the test/live firewall
    // lives in the route, but the schema's composite reference still requires
    // the pair to agree, so the fixture must be coherent).
    environment: network === 'mainnet' ? 'production' : 'development',
    network,
    xpub: XPUB,
    publicId: `merch_${unique}`,
  });
  return merchant!;
}

function intentParams(merchantId: string, overrides: Record<string, unknown> = {}) {
  const unique = uuidv7();
  return {
    publicId: `pi_${unique}`,
    merchantId,
    rail: 'faircoin' as const,
    amount: '100000000',
    currency: 'FAIR' as const,
    network: 'testnet' as const,
    address: `T${unique}`,
    provider: null,
    clientSecret: `pi_${unique}_secret_x`,
    idempotencyKey: unique,
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
    ...overrides,
  };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('payment intent repository', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  it('mints an intent with server-decided initial state', async () => {
    const merchant = await makeMerchant();
    const created = await insertPaymentIntent(suite!.db, intentParams(merchant.id));

    expect(created?.status).toBe('created');
    expect(created?.currency).toBe('FAIR');
    expect(created?.confirmations).toBe(0);
    expect(created?.txid).toBeNull();
    expect(created?.amount).toBe('100000000');
    expect(created?.metadata).toEqual({});
  });

  /**
   * The idempotency key is what stops one `Idempotency-Key` producing two
   * intents — and therefore two reserved addresses off one merchant's counter.
   * Converged on the index, not read first.
   */
  it('refuses a duplicate idempotency key for the same merchant', async () => {
    const merchant = await makeMerchant();
    const params = intentParams(merchant.id);
    expect(await insertPaymentIntent(suite!.db, params)).not.toBeNull();

    const second = await insertPaymentIntent(
      suite!.db,
      intentParams(merchant.id, {
        idempotencyKey: params.idempotencyKey,
        publicId: `pi_${uuidv7()}`,
        address: `T${uuidv7()}`,
        provider: null,
      })
    );
    expect(second).toBeNull();

    const winner = await findIntentByIdempotencyKey(suite!.db, merchant.id, params.idempotencyKey);
    expect(winner?.publicId).toBe(params.publicId);
  });

  /** The SAME key for a DIFFERENT merchant is a different intent — the key is scoped. */
  it('scopes the idempotency key to the merchant', async () => {
    const one = await makeMerchant();
    const two = await makeMerchant();
    const shared = uuidv7();

    expect(
      await insertPaymentIntent(suite!.db, intentParams(one.id, { idempotencyKey: shared }))
    ).not.toBeNull();
    expect(
      await insertPaymentIntent(suite!.db, intentParams(two.id, { idempotencyKey: shared }))
    ).not.toBeNull();
  });

  /**
   * The IDOR wall. A merchant-authed read must not return another merchant's
   * intent, and the ownership check lives in the WHERE clause — so a foreign
   * intent is indistinguishable from a missing one, which is what stops the
   * 404/403 difference leaking that the id exists.
   */
  it('never returns another merchant\'s intent from the scoped read', async () => {
    const owner = await makeMerchant();
    const stranger = await makeMerchant();
    const created = await insertPaymentIntent(suite!.db, intentParams(owner.id));

    expect((await findIntentForMerchant(suite!.db, created!.publicId, owner.id))?.id).toBe(
      created!.id
    );
    expect(await findIntentForMerchant(suite!.db, created!.publicId, stranger.id)).toBeNull();
    // The payer path is deliberately unscoped — it is authorized by the
    // client_secret instead, which is why the two are separate functions.
    expect((await findIntentByPublicId(suite!.db, created!.publicId))?.id).toBe(created!.id);
  });

  /**
   * The network firewall, enforced by the composite reference rather than by a
   * check the application could forget. A testnet merchant cannot own a mainnet
   * intent, whatever the caller asks for.
   */
  it('refuses an intent whose network disagrees with its merchant', async () => {
    const merchant = await makeMerchant('testnet');
    let raised: unknown;
    try {
      await insertPaymentIntent(suite!.db, intentParams(merchant.id, { network: 'mainnet' }));
    } catch (error) {
      raised = error;
    }
    expect(isForeignKeyViolation(raised, 'payment_intents_merchant_id_network_fkey')).toBe(true);
  });

  it('refuses a non-canonical amount', async () => {
    const merchant = await makeMerchant();
    for (const amount of ['01', '1.5', '-1', '']) {
      let raised: unknown;
      try {
        await insertPaymentIntent(suite!.db, intentParams(merchant.id, { amount }));
      } catch (error) {
        raised = error;
      }
      expect([amount, isCheckViolation(raised, 'payment_intents_amount_check')]).toEqual([
        amount,
        true,
      ]);
    }
  });

  /**
   * `broadcast` without a txid is refused by the database. That is why the state
   * change writes both in one statement — a two-step "set status, then set txid"
   * could not commit the first half at all.
   */
  it('refuses a broadcast state with no transaction id', async () => {
    const merchant = await makeMerchant();
    const created = await insertPaymentIntent(suite!.db, intentParams(merchant.id));

    let raised: unknown;
    try {
      await updateIntentState(suite!.db, created!.id, { from: 'created', status: 'broadcast' });
    } catch (error) {
      raised = error;
    }
    expect(
      isCheckViolation(raised, 'payment_intents_broadcast_requires_txid_check')
    ).toBe(true);

    const withTxid = await updateIntentState(suite!.db, created!.id, {
      from: 'created',
      status: 'broadcast',
      txid: 'a'.repeat(64),
    });
    expect(withTxid.kind).toBe('updated');
    const row = withTxid.kind === 'updated' ? withTxid.row : undefined;
    expect(row?.status).toBe('broadcast');
    expect(row?.txid).toBe('a'.repeat(64));
  });

  /**
   * Pagination is EXACT — no repeats, no skips — and that property does not
   * depend on the ids meaning anything, only on the key being unique and the
   * order total. Seeded WITHOUT any delay, so most of these rows share a
   * millisecond and their relative order is arbitrary; the walk must still
   * cover every row exactly once.
   *
   * Asserted as a set plus a count rather than a sequence: a sequence assertion
   * here would be testing the id generator's luck, and it failed for exactly
   * that reason the first time this was written.
   */
  it('pages without repeating or skipping a row, whatever the ids are', async () => {
    const merchant = await makeMerchant();
    const created: PaymentIntentRow[] = [];
    for (let index = 0; index < 6; index += 1) {
      created.push((await insertPaymentIntent(suite!.db, intentParams(merchant.id)))!);
    }

    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await listIntentsForMerchant(suite!.db, { merchantId: merchant.id, limit: 2, after });
      seen.push(...result.data.map((row) => row.publicId));
      expect(result.hasMore).toBe(page < 2);
      after = result.data.at(-1)?.id;
    }

    expect(seen.length).toBe(6);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual(created.map((row) => row.publicId).sort());
  });

  /**
   * Creation order holds to the MILLISECOND and no finer.
   *
   * `@oxy.so/db`'s uuid v7 is 48 bits of milliseconds plus randomness — RFC
   * 9562's optional monotonic counter is not used — so two ids minted in the
   * same millisecond invert about half the time (measured: 94 of 200 pairs).
   * That is a real difference from Mongo, whose ObjectId carries a per-process
   * counter and is monotonic within its one-second timestamp.
   *
   * So the ordering claim is tested with rows in DISTINCT milliseconds, which
   * is the resolution the guarantee actually has. A test without the sleep
   * would be asserting the generator's luck.
   */
  it('returns newest-first for rows created in distinct milliseconds', async () => {
    const merchant = await makeMerchant();
    const created: PaymentIntentRow[] = [];
    for (let index = 0; index < 4; index += 1) {
      created.push((await insertPaymentIntent(suite!.db, intentParams(merchant.id)))!);
      await Bun.sleep(2);
    }

    const page = await listIntentsForMerchant(suite!.db, { merchantId: merchant.id, limit: 10 });
    expect(page.data.map((row) => row.publicId)).toEqual(
      [...created].reverse().map((row) => row.publicId)
    );
  });

  it('filters a page by status and excludes other merchants', async () => {
    const merchant = await makeMerchant();
    const stranger = await makeMerchant();
    const settled = await insertPaymentIntent(suite!.db, intentParams(merchant.id));
    await updateIntentState(suite!.db, settled!.id, {
      from: 'created',
      status: 'broadcast',
      txid: 'b'.repeat(64),
    });
    await insertPaymentIntent(suite!.db, intentParams(merchant.id));
    await insertPaymentIntent(suite!.db, intentParams(stranger.id));

    const page = await listIntentsForMerchant(suite!.db, {
      merchantId: merchant.id,
      status: 'broadcast',
      limit: 10,
    });
    expect(page.data.map((row) => row.publicId)).toEqual([settled!.publicId]);
    expect(page.hasMore).toBe(false);
  });

  it('resolves intents by address, and answers an empty input without a query', async () => {
    const merchant = await makeMerchant();
    const first = await insertPaymentIntent(suite!.db, intentParams(merchant.id));
    const second = await insertPaymentIntent(suite!.db, intentParams(merchant.id));

    // Non-null assertions rather than a guard: `intentParams` builds faircoin
    // intents, and `payment_intents_faircoin_requires_chain_fields_check`
    // refuses one without an address, so a null here would mean the constraint
    // is gone — which this suite should fail on, loudly.
    const found = await findIntentsByAddresses(suite!.db, [
      first!.address!,
      second!.address!,
      'Tnope',
    ]);
    expect(found.map((row) => row.publicId).sort()).toEqual(
      [first!.publicId, second!.publicId].sort()
    );

    // The empty input answers empty. That is the behaviour, not the guard: on
    // drizzle-orm 0.45.2 `inArray(col, [])` renders `where false`, so the
    // short-circuit saves a round trip rather than avoiding a syntax error.
    expect(await findIntentsByAddresses(suite!.db, [])).toEqual([]);
  });

  /**
   * The watcher's own filter. An in-flight intent with NO txid must be excluded
   * — there is nothing to look up on chain — and a terminal one must be too.
   * Both negatives are seeded, because a query returning only the positive would
   * pass whether or not either exclusion worked.
   */
  it('selects only in-flight intents that carry a transaction id', async () => {
    const merchant = await makeMerchant();
    const watchable = await insertPaymentIntent(suite!.db, intentParams(merchant.id));
    await updateIntentState(suite!.db, watchable!.id, {
      from: 'created',
      status: 'broadcast',
      txid: 'c'.repeat(64),
    });
    // A `failed` intent with NO txid. This is the fixture that discriminates,
    // and finding it took a surviving mutation to notice: a `created` intent is
    // excluded by the STATUS predicate, so seeding one proves nothing about the
    // txid predicate — removing `isNotNull` left the suite green.
    //
    // It has to be `failed` specifically, because
    // `payment_intents_broadcast_requires_txid_check` makes a txid-less
    // broadcast/confirming/settled row UNREPRESENTABLE. `approved → failed` is
    // the one legal transition into a queryable status that no writer pairs
    // with a txid — which is exactly why `failed` is outside that CHECK.
    const noTxid = await insertPaymentIntent(suite!.db, intentParams(merchant.id));
    await updateIntentState(suite!.db, noTxid!.id, {
      from: 'created',
      status: 'awaiting_approval',
    });
    await updateIntentState(suite!.db, noTxid!.id, {
      from: 'awaiting_approval',
      status: 'approved',
    });
    await updateIntentState(suite!.db, noTxid!.id, { from: 'approved', status: 'failed' });
    // Carrying a txid is not enough either: settled is terminal.
    const terminal = await insertPaymentIntent(suite!.db, intentParams(merchant.id));
    await updateIntentState(suite!.db, terminal!.id, {
      from: 'created',
      status: 'broadcast',
      txid: 'd'.repeat(64),
    });
    await updateIntentState(suite!.db, terminal!.id, { from: 'broadcast', status: 'confirming' });
    await updateIntentState(suite!.db, terminal!.id, {
      from: 'confirming',
      status: 'settled',
      confirmations: 6,
    });

    const found = await findWatchableIntents(suite!.db, ['broadcast', 'confirming']);
    const ids = found.map((row) => row.publicId);
    expect(ids).toContain(watchable!.publicId);
    expect(ids).not.toContain(terminal!.publicId);

    // The txid predicate, exercised on the only status where it can matter.
    // Querying `failed` returns the txid-less row if `isNotNull` is dropped.
    const failedWithTxid = await insertPaymentIntent(suite!.db, intentParams(merchant.id));
    await updateIntentState(suite!.db, failedWithTxid!.id, {
      from: 'created',
      status: 'broadcast',
      txid: 'e'.repeat(64),
    });
    await updateIntentState(suite!.db, failedWithTxid!.id, {
      from: 'broadcast',
      status: 'failed',
    });

    const failedOnes = (await findWatchableIntents(suite!.db, ['failed'])).map((row) => row.publicId);
    expect(failedOnes).toContain(failedWithTxid!.publicId);
    expect(failedOnes).not.toContain(noTxid!.publicId);
  });

  /**
   * The two id spaces, told apart.
   *
   * `checkout_sessions.payment_intent_id` holds the intent's PRIMARY KEY where
   * the Mongo document held the public `pi_…`, so resolving a session's wrapped
   * intent is a different lookup from resolving one a payer named. Every
   * assertion but the second would pass a read that matched on `public_id`
   * instead — it returns the same row — so the discriminating case is the one
   * that hands the public id to the internal read and requires nothing back.
   */
  it('resolves an intent by its internal id, and never by its public id', async () => {
    const merchant = await makeMerchant();
    const created = (await insertPaymentIntent(suite!.db, intentParams(merchant.id)))!;

    expect((await findIntentById(suite!.db, created.id))?.publicId).toBe(created.publicId);
    expect(await findIntentById(suite!.db, created.publicId)).toBeNull();
    expect(await findIntentById(suite!.db, uuidv7())).toBeNull();
  });

  /**
   * The IDOR wall on the redelivery path's lookup.
   *
   * A `webhook_deliveries` row names its intent by primary key, and redelivery
   * loads it under merchant authentication — so the scope is re-stated in the
   * WHERE clause. The fixture is a SECOND merchant, because a one-sided one
   * passes whether or not the predicate is there: the id is unique, so dropping
   * the merchant term still returns exactly one row, and it is the owner's.
   */
  it('never returns another merchant\'s intent from the by-id scoped read', async () => {
    const owner = await makeMerchant();
    const stranger = await makeMerchant();
    const created = (await insertPaymentIntent(suite!.db, intentParams(owner.id)))!;

    expect((await findIntentByIdForMerchant(suite!.db, created.id, owner.id))?.publicId).toBe(
      created.publicId
    );
    // A foreign row and a missing one are the same answer, so the caller's 404
    // cannot be told from its other 404 — existence does not leak.
    expect(await findIntentByIdForMerchant(suite!.db, created.id, stranger.id)).toBeNull();
    expect(await findIntentByIdForMerchant(suite!.db, uuidv7(), owner.id)).toBeNull();
    // The mix-up the identical signatures invite, priced: handing the scoped
    // by-id read a `pi_…` matches nothing. It never returns a different intent.
    expect(await findIntentByIdForMerchant(suite!.db, created.publicId, owner.id)).toBeNull();
  });

  it('returns null for an unknown intent rather than throwing', async () => {
    expect(await findIntentByPublicId(suite!.db, `pi_${uuidv7()}`)).toBeNull();
    // `missing`, not `stale`: the compare-and-swap tells "no such row" apart
    // from "the row moved", and only the first is a 404 to a caller.
    expect(await updateIntentState(suite!.db, uuidv7(), { from: 'created', status: 'expired' }))
      .toEqual({ kind: 'missing' });
  });
});
