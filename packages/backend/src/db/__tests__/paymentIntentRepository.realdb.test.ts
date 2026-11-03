import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { must } from '../../__tests__/helpers/must';
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
  const merchant = await insertMerchant(must(suite).db, {
    oxyAppId: `app_${unique}`,
    // A mainnet merchant needs a production environment (the test/live firewall
    // lives in the route, but the schema's composite reference still requires
    // the pair to agree, so the fixture must be coherent).
    environment: network === 'mainnet' ? 'production' : 'development',
    network,
    xpub: XPUB,
    publicId: `merch_${unique}`,
  });
  return must(merchant);
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
    status: 'requires_action' as const,
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
    const created = await insertPaymentIntent(must(suite).db, intentParams(merchant.id));

    expect(created?.status).toBe('requires_action');
    // ADR 0019: nothing received, nothing refunded, nothing cancelled — and the
    // merchant's PUBLIC id read in the same statement.
    expect(created?.amountReceived).toBe('0');
    expect(created?.amountRefunded).toBe('0');
    expect(created?.cancellationReason).toBeNull();
    expect(created?.canceledAt).toBeNull();
    expect(created?.merchantPublicId).toBe(merchant.publicId);
    expect(created?.requiredConfirmations).toBe(merchant.requiredConfirmations);
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
    expect(await insertPaymentIntent(must(suite).db, params)).not.toBeNull();

    const second = await insertPaymentIntent(
      must(suite).db,
      intentParams(merchant.id, {
        idempotencyKey: params.idempotencyKey,
        publicId: `pi_${uuidv7()}`,
        address: `T${uuidv7()}`,
        provider: null,
      }),
    );
    expect(second).toBeNull();

    const winner = await findIntentByIdempotencyKey(
      must(suite).db,
      merchant.id,
      params.idempotencyKey,
    );
    expect(winner?.publicId).toBe(params.publicId);
  });

  /** The SAME key for a DIFFERENT merchant is a different intent — the key is scoped. */
  it('scopes the idempotency key to the merchant', async () => {
    const one = await makeMerchant();
    const two = await makeMerchant();
    const shared = uuidv7();

    expect(
      await insertPaymentIntent(must(suite).db, intentParams(one.id, { idempotencyKey: shared })),
    ).not.toBeNull();
    expect(
      await insertPaymentIntent(must(suite).db, intentParams(two.id, { idempotencyKey: shared })),
    ).not.toBeNull();
  });

  /**
   * The IDOR wall. A merchant-authed read must not return another merchant's
   * intent, and the ownership check lives in the WHERE clause — so a foreign
   * intent is indistinguishable from a missing one, which is what stops the
   * 404/403 difference leaking that the id exists.
   */
  it("never returns another merchant's intent from the scoped read", async () => {
    const owner = await makeMerchant();
    const stranger = await makeMerchant();
    const created = await insertPaymentIntent(must(suite).db, intentParams(owner.id));

    expect(
      (await findIntentForMerchant(must(suite).db, must(created).publicId, owner.id))?.id,
    ).toBe(must(created).id);
    expect(
      await findIntentForMerchant(must(suite).db, must(created).publicId, stranger.id),
    ).toBeNull();
    // The payer path is deliberately unscoped — it is authorized by the
    // client_secret instead, which is why the two are separate functions.
    expect((await findIntentByPublicId(must(suite).db, must(created).publicId))?.id).toBe(
      must(created).id,
    );
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
      await insertPaymentIntent(must(suite).db, intentParams(merchant.id, { network: 'mainnet' }));
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
        await insertPaymentIntent(must(suite).db, intentParams(merchant.id, { amount }));
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
   * A FairCoin `processing` without a txid is refused by the database. That is
   * why the state change writes both in one statement — a two-step "set status,
   * then set txid" could not commit the first half at all.
   */
  it('refuses a processing FairCoin intent with no transaction id', async () => {
    const merchant = await makeMerchant();
    const created = await insertPaymentIntent(must(suite).db, intentParams(merchant.id));

    let raised: unknown;
    try {
      await updateIntentState(must(suite).db, must(created).id, {
        from: 'requires_action',
        status: 'processing',
      });
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'payment_intents_processing_requires_txid_check')).toBe(true);

    const withTxid = await updateIntentState(must(suite).db, must(created).id, {
      from: 'requires_action',
      status: 'processing',
      txid: 'a'.repeat(64),
    });
    expect(withTxid.kind).toBe('updated');
    const row = withTxid.kind === 'updated' ? withTxid.row : undefined;
    expect(row?.status).toBe('processing');
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
      created.push(must(await insertPaymentIntent(must(suite).db, intentParams(merchant.id))));
    }

    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await listIntentsForMerchant(must(suite).db, {
        merchantId: merchant.id,
        page: { limit: 2, after: after },
      });
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
   * Ids are therefore NOT monotonic within a millisecond.
   *
   * So the ordering claim is tested with rows in DISTINCT milliseconds, which
   * is the resolution the guarantee actually has. A test without the sleep
   * would be asserting the generator's luck.
   */
  it('returns newest-first for rows created in distinct milliseconds', async () => {
    const merchant = await makeMerchant();
    const created: PaymentIntentRow[] = [];
    for (let index = 0; index < 4; index += 1) {
      created.push(must(await insertPaymentIntent(must(suite).db, intentParams(merchant.id))));
      await Bun.sleep(2);
    }

    const page = await listIntentsForMerchant(must(suite).db, {
      merchantId: merchant.id,
      page: { limit: 10 },
    });
    expect(page.data.map((row) => row.publicId)).toEqual(
      [...created].reverse().map((row) => row.publicId),
    );
  });

  it('filters a page by status and excludes other merchants', async () => {
    const merchant = await makeMerchant();
    const stranger = await makeMerchant();
    const settled = await insertPaymentIntent(must(suite).db, intentParams(merchant.id));
    await updateIntentState(must(suite).db, must(settled).id, {
      from: 'requires_action',
      status: 'processing',
      txid: 'b'.repeat(64),
    });
    await insertPaymentIntent(must(suite).db, intentParams(merchant.id));
    await insertPaymentIntent(must(suite).db, intentParams(stranger.id));

    const page = await listIntentsForMerchant(must(suite).db, {
      merchantId: merchant.id,
      status: 'processing',
      page: { limit: 10 },
    });
    expect(page.data.map((row) => row.publicId)).toEqual([must(settled).publicId]);
    expect(page.hasMore).toBe(false);
  });

  it('resolves intents by address, and answers an empty input without a query', async () => {
    const merchant = await makeMerchant();
    const first = await insertPaymentIntent(must(suite).db, intentParams(merchant.id));
    const second = await insertPaymentIntent(must(suite).db, intentParams(merchant.id));

    // Non-null assertions rather than a guard: `intentParams` builds faircoin
    // intents, and `payment_intents_faircoin_requires_chain_fields_check`
    // refuses one without an address, so a null here would mean the constraint
    // is gone — which this suite should fail on, loudly.
    const found = await findIntentsByAddresses(must(suite).db, [
      must(must(first).address),
      must(must(second).address),
      'Tnope',
    ]);
    expect(found.map((row) => row.publicId).sort()).toEqual(
      [must(first).publicId, must(second).publicId].sort(),
    );

    // The empty input answers empty. That is the behaviour, not the guard: on
    // drizzle-orm 0.45.2 `inArray(col, [])` renders `where false`, so the
    // short-circuit saves a round trip rather than avoiding a syntax error.
    expect(await findIntentsByAddresses(must(suite).db, [])).toEqual([]);
  });

  /**
   * The watcher's own filter. An in-flight intent with NO txid must be excluded
   * — there is nothing to look up on chain — and a terminal one must be too.
   * Both negatives are seeded, because a query returning only the positive would
   * pass whether or not either exclusion worked.
   */
  it('selects only in-flight intents that carry a transaction id', async () => {
    const merchant = await makeMerchant();
    const watchable = await insertPaymentIntent(must(suite).db, intentParams(merchant.id));
    await updateIntentState(must(suite).db, must(watchable).id, {
      from: 'requires_action',
      status: 'processing',
      txid: 'c'.repeat(64),
    });
    // A `canceled` intent with NO txid (it expired). This is the fixture that
    // discriminates, and finding it took a surviving mutation to notice: a
    // `requires_action` intent is excluded by the STATUS predicate, so seeding
    // one proves nothing about the txid predicate.
    //
    // It has to be `canceled` specifically, because
    // `payment_intents_processing_requires_txid_check` makes a txid-less
    // processing/succeeded FairCoin row UNREPRESENTABLE; `canceled` is the one
    // queryable status that holds rows both with a txid (underpaid) and without.
    const noTxid = await insertPaymentIntent(must(suite).db, intentParams(merchant.id));
    await updateIntentState(must(suite).db, must(noTxid).id, {
      from: 'requires_action',
      status: 'canceled',
      cancellationReason: 'abandoned',
    });
    // Carrying a txid is not enough either: succeeded is terminal.
    const terminal = await insertPaymentIntent(must(suite).db, intentParams(merchant.id));
    await updateIntentState(must(suite).db, must(terminal).id, {
      from: 'requires_action',
      status: 'processing',
      txid: 'd'.repeat(64),
    });
    await updateIntentState(must(suite).db, must(terminal).id, {
      from: 'processing',
      status: 'succeeded',
      confirmations: 6,
    });

    const found = await findWatchableIntents(must(suite).db, ['processing']);
    const ids = found.map((row) => row.publicId);
    expect(ids).toContain(must(watchable).publicId);
    expect(ids).not.toContain(must(terminal).publicId);

    // The txid predicate, exercised on the only status where it can matter.
    // Querying `canceled` returns the txid-less row if `isNotNull` is dropped.
    const underpaid = await insertPaymentIntent(must(suite).db, intentParams(merchant.id));
    await updateIntentState(must(suite).db, must(underpaid).id, {
      from: 'requires_action',
      status: 'processing',
      txid: 'e'.repeat(64),
    });
    await updateIntentState(must(suite).db, must(underpaid).id, {
      from: 'processing',
      status: 'canceled',
      cancellationReason: 'underpaid',
    });

    const canceledOnes = (await findWatchableIntents(must(suite).db, ['canceled'])).map(
      (row) => row.publicId,
    );
    expect(canceledOnes).toContain(must(underpaid).publicId);
    expect(canceledOnes).not.toContain(must(noTxid).publicId);
  });

  /**
   * What a transition writes with the status (ADR 0019): a cancellation stamps
   * its reason and instant; success receives the amount; ANY other transition
   * clears a stale `last_payment_error`, and leaving `succeeded` (a reorg)
   * un-receives the money. And the CHECKs hold those agreements even for a
   * writer that skipped the repository.
   */
  it('writes the fields a transition decides, in the same statement', async () => {
    const merchant = await makeMerchant();
    const intent = must(await insertPaymentIntent(must(suite).db, intentParams(merchant.id)));
    const processing = await updateIntentState(must(suite).db, intent.id, {
      from: 'requires_action',
      status: 'processing',
      txid: 'f'.repeat(64),
    });
    expect(processing.kind === 'updated' ? processing.row.amountReceived : null).toBe('0');
    const succeeded = await updateIntentState(must(suite).db, intent.id, {
      from: 'processing',
      status: 'succeeded',
    });
    expect(succeeded.kind === 'updated' ? succeeded.row.amountReceived : null).toBe('100000000');
    const rewound = await updateIntentState(must(suite).db, intent.id, {
      from: 'succeeded',
      status: 'processing',
    });
    expect(rewound.kind === 'updated' ? rewound.row.amountReceived : null).toBe('0');

    const canceled = must(await insertPaymentIntent(must(suite).db, intentParams(merchant.id)));
    const result = await updateIntentState(must(suite).db, canceled.id, {
      from: 'requires_action',
      status: 'canceled',
      cancellationReason: 'requested_by_customer',
    });
    const row = result.kind === 'updated' ? result.row : undefined;
    expect(row?.cancellationReason).toBe('requested_by_customer');
    expect(row?.canceledAt).toBeInstanceOf(Date);

    let raised: unknown;
    try {
      await must(suite)
        .client`update payment_intents set cancellation_reason = 'duplicate', canceled_at = null where id = ${intent.id}`;
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'payment_intents_canceled_agrees_check')).toBe(true);
    raised = undefined;
    try {
      await must(suite)
        .client`update payment_intents set amount_received = amount where id = ${intent.id}`;
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'payment_intents_amount_received_agrees_check')).toBe(true);
  });

  /** A chain payment refuses the card-only statuses and fields (ADR 0019). */
  it('keeps the card-only statuses and fields off the FairCoin rail', async () => {
    const merchant = await makeMerchant();
    const intent = must(await insertPaymentIntent(must(suite).db, intentParams(merchant.id)));
    for (const [statement, constraint] of [
      [
        must(suite)
          .client`update payment_intents set status = 'requires_capture' where id = ${intent.id}`,
        'payment_intents_card_statuses_are_card_check',
      ],
      [
        must(suite)
          .client`update payment_intents set capture_method = 'manual' where id = ${intent.id}`,
        'payment_intents_card_only_fields_check',
      ],
      [
        must(suite).client`update payment_intents set status = 'created' where id = ${intent.id}`,
        'payment_intents_status_check',
      ],
    ] as const) {
      let raised: unknown;
      try {
        await statement;
      } catch (error) {
        raised = error;
      }
      expect([constraint, isCheckViolation(raised, constraint)]).toEqual([constraint, true]);
    }
  });

  /**
   * The two id spaces, told apart.
   *
   * `checkout_sessions.payment_intent_id` holds the intent's PRIMARY KEY, not
   * the public `pi_…`, so resolving a session's wrapped
   * intent is a different lookup from resolving one a payer named. Every
   * assertion but the second would pass a read that matched on `public_id`
   * instead — it returns the same row — so the discriminating case is the one
   * that hands the public id to the internal read and requires nothing back.
   */
  it('resolves an intent by its internal id, and never by its public id', async () => {
    const merchant = await makeMerchant();
    const created = must(await insertPaymentIntent(must(suite).db, intentParams(merchant.id)));

    expect((await findIntentById(must(suite).db, created.id))?.publicId).toBe(created.publicId);
    expect(await findIntentById(must(suite).db, created.publicId)).toBeNull();
    expect(await findIntentById(must(suite).db, uuidv7())).toBeNull();
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
  it("never returns another merchant's intent from the by-id scoped read", async () => {
    const owner = await makeMerchant();
    const stranger = await makeMerchant();
    const created = must(await insertPaymentIntent(must(suite).db, intentParams(owner.id)));

    expect((await findIntentByIdForMerchant(must(suite).db, created.id, owner.id))?.publicId).toBe(
      created.publicId,
    );
    // A foreign row and a missing one are the same answer, so the caller's 404
    // cannot be told from its other 404 — existence does not leak.
    expect(await findIntentByIdForMerchant(must(suite).db, created.id, stranger.id)).toBeNull();
    expect(await findIntentByIdForMerchant(must(suite).db, uuidv7(), owner.id)).toBeNull();
    // The mix-up the identical signatures invite, priced: handing the scoped
    // by-id read a `pi_…` matches nothing. It never returns a different intent.
    expect(await findIntentByIdForMerchant(must(suite).db, created.publicId, owner.id)).toBeNull();
  });

  it('returns null for an unknown intent rather than throwing', async () => {
    expect(await findIntentByPublicId(must(suite).db, `pi_${uuidv7()}`)).toBeNull();
    // `missing`, not `stale`: the compare-and-swap tells "no such row" apart
    // from "the row moved", and only the first is a 404 to a caller.
    expect(
      await updateIntentState(must(suite).db, uuidv7(), {
        from: 'requires_action',
        status: 'canceled',
      }),
    ).toEqual({ kind: 'missing' });
  });
});
