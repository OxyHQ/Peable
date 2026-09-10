import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { isCheckViolation, isForeignKeyViolation, uuidv7 } from '@oxy.so/db';
import { insertMerchant, type MerchantRow } from '../merchants/merchantRepository';
import { insertPaymentIntent } from '../payments/paymentIntentRepository';
import {
  findDeliveryForMerchant,
  listDeliveriesForMerchant,
} from '../webhooks/webhookDeliveryRepository';
import {
  enqueueWebhook,
  recordDeliveryAttempt,
} from '../webhooks/webhookOutboxRepository';
import {
  findAttributionsForViewer,
  insertSendAttribution,
  listAttributionsForViewer,
} from '../social/sendAttribution';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

const XPUB =
  'DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn';

let suite: SuiteDatabase | undefined;

async function makeMerchant(): Promise<MerchantRow> {
  const unique = uuidv7();
  return (await insertMerchant(suite!.db, {
    oxyAppId: `app_${unique}`,
    environment: 'development',
    network: 'testnet',
    xpub: XPUB,
    publicId: `merch_${unique}`,
  }))!;
}

async function makeIntent(merchant: MerchantRow) {
  const unique = uuidv7();
  return (await insertPaymentIntent(suite!.db, {
    publicId: `pi_${unique}`,
    merchantId: merchant.id,
    rail: 'faircoin' as const,
    amount: '100000000',
    currency: 'FAIR' as const,
    network: merchant.network,
    address: `T${unique}`,
    provider: null,
    clientSecret: `pi_${unique}_secret_x`,
    idempotencyKey: unique,
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
  }))!;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('webhook delivery and social attribution repositories', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  /**
   * A minimal event body. The outbox stores the envelope verbatim, so a fixture
   * only has to be a JSON object — nothing here parses it.
   */
  function eventFor(type: 'payment_intent.settled' | 'payment_intent.failed') {
    const id = `evt_${uuidv7()}`;
    return {
      id,
      object: 'event' as const,
      type,
      created: new Date().toISOString(),
      data: { object: {} },
    };
  }

  /**
   * A settled delivery — enqueue, then record one successful attempt.
   *
   * Two writes because that is the only path a row now has: `enqueueWebhook`
   * creates it and `recordDeliveryAttempt` finishes it. The cases below only
   * need a delivery to EXIST, so the shape is hidden here rather than repeated.
   */
  async function makeDelivery(
    merchant: MerchantRow,
    intent: { id: string },
    url = 'https://merchant.example/hook'
  ) {
    const id = await enqueueWebhook(suite!.db, {
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      event: eventFor('payment_intent.settled') as never,
      url,
    });
    await recordDeliveryAttempt(suite!.db, {
      id,
      outcome: { kind: 'delivered' },
      url,
      nextAttemptAt: null,
    });
    const row = await findDeliveryForMerchant(suite!.db, id, merchant.id);
    if (!row) throw new Error(`makeDelivery: delivery ${id} vanished`);
    return row;
  }

  /**
   * An enqueued delivery is PENDING with zero attempts and a due time.
   *
   * The row existing before any attempt is the whole of ADR 0001 D7, and it is
   * also what the previous `attempts > 0` CHECK forbade — a constraint written
   * when a row could only be created after `deliver()` had already run.
   */
  it('enqueues a pending delivery with no attempts and a schedule', async () => {
    const merchant = await makeMerchant();
    const intent = await makeIntent(merchant);

    const id = await enqueueWebhook(suite!.db, {
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      event: eventFor('payment_intent.settled') as never,
      url: 'https://merchant.example/hook',
    });

    const row = await findDeliveryForMerchant(suite!.db, id, merchant.id);
    expect(row?.lastStatus).toBe('pending');
    expect(row?.delivered).toBe(false);
    expect(row?.attempts).toBe(0);
    expect(row?.nextAttemptAt).not.toBeNull();
    expect(row?.lastError).toBeNull();
  });

  /**
   * `last_status` is derived from `delivered` at the single write point, so the
   * pair can never disagree — and no caller has a parameter with which to make
   * them. Both truth values are exercised, because deriving only one correctly
   * would still pass a test that checked one.
   */
  it('derives last_status from delivered, both ways', async () => {
    const merchant = await makeMerchant();
    const intent = await makeIntent(merchant);

    const okId = await enqueueWebhook(suite!.db, {
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      event: eventFor('payment_intent.settled') as never,
      url: 'https://merchant.example/hook',
    });
    await recordDeliveryAttempt(suite!.db, {
      id: okId,
      outcome: { kind: 'delivered' },
      url: 'https://merchant.example/hook',
      nextAttemptAt: null,
    });
    const ok = await findDeliveryForMerchant(suite!.db, okId, merchant.id);
    expect(ok?.lastStatus).toBe('delivered');
    expect(ok?.delivered).toBe(true);

    const badId = await enqueueWebhook(suite!.db, {
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      event: eventFor('payment_intent.failed') as never,
      url: 'https://merchant.example/hook',
    });
    await recordDeliveryAttempt(suite!.db, {
      id: badId,
      outcome: { kind: 'refused', reason: 'target responded 410' },
      url: 'https://merchant.example/hook',
      nextAttemptAt: null,
    });
    const failed = await findDeliveryForMerchant(suite!.db, badId, merchant.id);
    expect(failed?.lastStatus).toBe('failed');
    expect(failed?.delivered).toBe(false);
    expect(failed?.lastError).toBe('target responded 410');
  });

  /**
   * A terminal delivery carries no schedule, and a pending one always does.
   *
   * Both directions are the failure this table was rebuilt to remove, from
   * opposite ends: a pending row with no `next_attempt_at` is an event no query
   * will ever surface again, and a terminal row that kept its schedule would be
   * redelivered forever after it had already succeeded.
   */
  it('ties the schedule to the status in both directions', async () => {
    const merchant = await makeMerchant();
    const intent = await makeIntent(merchant);

    const id = await enqueueWebhook(suite!.db, {
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      event: eventFor('payment_intent.settled') as never,
      url: 'https://merchant.example/hook',
    });

    // Retrying: still pending, still scheduled.
    await recordDeliveryAttempt(suite!.db, {
      id,
      outcome: { kind: 'retry', reason: 'target responded 503' },
      url: 'https://merchant.example/hook',
      nextAttemptAt: new Date(Date.now() + 5_000),
    });
    const retrying = await findDeliveryForMerchant(suite!.db, id, merchant.id);
    expect(retrying?.lastStatus).toBe('pending');
    expect(retrying?.attempts).toBe(1);
    expect(retrying?.nextAttemptAt).not.toBeNull();

    // Budget spent: dead, and unscheduled.
    await recordDeliveryAttempt(suite!.db, {
      id,
      outcome: { kind: 'retry', reason: 'target responded 503' },
      url: 'https://merchant.example/hook',
      nextAttemptAt: null,
    });
    const dead = await findDeliveryForMerchant(suite!.db, id, merchant.id);
    expect(dead?.lastStatus).toBe('dead');
    expect(dead?.attempts).toBe(2);
    expect(dead?.nextAttemptAt).toBeNull();
  });

  it('refuses a pending delivery with no schedule', async () => {
    const merchant = await makeMerchant();
    const intent = await makeIntent(merchant);
    const id = await enqueueWebhook(suite!.db, {
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      event: eventFor('payment_intent.settled') as never,
      url: 'https://merchant.example/hook',
    });

    let raised: unknown;
    try {
      // The shape no writer produces and every writer must be unable to: still
      // claimable in principle, but with nothing to make it due.
      await suite!.db.execute(
        sql`update webhook_deliveries set next_attempt_at = null where id = ${id}`
      );
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'webhook_deliveries_schedule_agrees_check')).toBe(true);
  });

  it('refuses a delivery for an intent that does not exist', async () => {
    const merchant = await makeMerchant();
    let raised: unknown;
    try {
      await enqueueWebhook(suite!.db, {
        merchantId: merchant.id,
        paymentIntentId: uuidv7(),
        event: eventFor('payment_intent.settled') as never,
        url: 'https://merchant.example/hook',
      });
    } catch (error) {
      raised = error;
    }
    expect(
      isForeignKeyViolation(raised, 'webhook_deliveries_payment_intent_id_payment_intents_id_fk')
    ).toBe(true);
  });

  it('never returns another merchant\'s delivery', async () => {
    const owner = await makeMerchant();
    const stranger = await makeMerchant();
    const intent = await makeIntent(owner);
    const delivery = await makeDelivery(owner, intent, 'https://merchant.example/hook');

    expect((await findDeliveryForMerchant(suite!.db, delivery.id, owner.id))?.id).toBe(delivery.id);
    expect(await findDeliveryForMerchant(suite!.db, delivery.id, stranger.id)).toBeNull();
  });

  /**
   * The cursor no longer needs an ObjectId format guard. An id of ANY shape that
   * does not exist simply pages nothing — which is what the deleted
   * `mongoose.isValidObjectId` check was really protecting against, expressed by
   * the lookup itself rather than by a format test.
   */
  it('pages a merchant\'s log and tolerates a cursor of any shape', async () => {
    const merchant = await makeMerchant();
    const intent = await makeIntent(merchant);
    for (let index = 0; index < 3; index += 1) {
      await makeDelivery(merchant, intent, 'https://merchant.example/hook');
    }

    const first = await listDeliveriesForMerchant(suite!.db, { merchantId: merchant.id, limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await listDeliveriesForMerchant(suite!.db, {
      merchantId: merchant.id,
      limit: 2,
      after: first.data.at(-1)!.id,
    });
    expect(second.data).toHaveLength(1);
    expect(second.hasMore).toBe(false);

    // A 24-char ObjectId hex — the shape the deleted guard used to accept, and
    // which is now simply an id that matches nothing.
    const legacyShaped = await listDeliveriesForMerchant(suite!.db, {
      merchantId: merchant.id,
      limit: 2,
      after: '0'.repeat(24),
    });
    expect(legacyShaped.data).toEqual([]);
  });

  /**
   * `WebhookDelivery.intentId` is a shipped wire field holding the public
   * `pi_…`, and the row stores the intent's primary key — so the list read
   * joins, rather than the route resolving one intent per row on a page whose
   * size the client chooses.
   *
   * TWO intents, and a third owned by another merchant, on purpose. With every
   * delivery pointing at one intent, a join on the wrong column — or one whose
   * predicate was dropped into a cross join — yields the same public id for
   * every row and passes. The page LENGTH is what catches the cross join: 3
   * deliveries against 3 intents would come back as 9 rows.
   */
  it('yields each delivery\'s own intent public id', async () => {
    const merchant = await makeMerchant();
    const stranger = await makeMerchant();
    const first = await makeIntent(merchant);
    const second = await makeIntent(merchant);
    const strangerIntent = await makeIntent(stranger);

    const expectedPublicId = new Map<string, string>();
    for (const intent of [first, second, first]) {
      const row = await makeDelivery(merchant, intent, 'https://merchant.example/hook');
      expectedPublicId.set(row.id, intent.publicId);
    }
    const strangerDelivery = await makeDelivery(stranger, strangerIntent, 'https://stranger.example/hook');

    const page = await listDeliveriesForMerchant(suite!.db, {
      merchantId: merchant.id,
      limit: 10,
    });

    // The join is 1:1 by construction — `payment_intent_id` is NOT NULL and
    // references a primary key — so it can neither drop a delivery nor
    // duplicate one, and the page size is exactly what it was without it.
    expect(page.data).toHaveLength(3);
    expect(page.data.map((row) => row.id)).not.toContain(strangerDelivery.id);
    for (const row of page.data) {
      expect([row.id, row.intentPublicId]).toEqual([row.id, expectedPublicId.get(row.id)!]);
    }
  });

  it('attributes an address to one payment relationship, once', async () => {
    const address = `T${uuidv7()}`;
    const sender = uuidv7();
    const recipient = uuidv7();

    const created = await insertSendAttribution(suite!.db, {
      address,
      network: 'testnet',
      senderUserId: sender,
      recipientUserId: recipient,
      derivationIndex: 1,
    });
    expect(created?.derivationIndex).toBe(1);

    // Single-use: a second relationship claiming the same address is refused.
    expect(
      await insertSendAttribution(suite!.db, {
        address,
        network: 'testnet',
        senderUserId: uuidv7(),
        recipientUserId: uuidv7(),
        derivationIndex: 2,
      })
    ).toBeNull();
  });

  it('refuses an attribution at the recipient\'s default index', async () => {
    let raised: unknown;
    try {
      await insertSendAttribution(suite!.db, {
        address: `T${uuidv7()}`,
        network: 'testnet',
        senderUserId: uuidv7(),
        recipientUserId: uuidv7(),
        derivationIndex: 0,
      });
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'social_send_attributions_derivation_index_check')).toBe(true);
  });

  /**
   * An attribution names two Oxy users, so returning one to anybody else tells a
   * stranger who paid whom. Both parties are seeded AND a third party, because a
   * query returning only the sender's view would pass whether or not the
   * recipient half worked, and one returning everything would pass both.
   */
  it('shows an attribution to both parties and to nobody else', async () => {
    const address = `T${uuidv7()}`;
    const sender = uuidv7();
    const recipient = uuidv7();
    const stranger = uuidv7();
    await insertSendAttribution(suite!.db, {
      address,
      network: 'testnet',
      senderUserId: sender,
      recipientUserId: recipient,
      derivationIndex: 1,
    });

    expect((await findAttributionsForViewer(suite!.db, [address], sender)).map((r) => r.address)).toEqual([address]);
    expect((await findAttributionsForViewer(suite!.db, [address], recipient)).map((r) => r.address)).toEqual([address]);
    expect(await findAttributionsForViewer(suite!.db, [address], stranger)).toEqual([]);
  });

  it('answers an empty address list without a query', async () => {
    expect(await findAttributionsForViewer(suite!.db, [], uuidv7())).toEqual([]);
  });

  /**
   * The address-free view, for a surface that cannot derive addresses of its
   * own (the web build has no key, so it cannot know which addresses are its).
   *
   * Same leak risk as `findAttributionsForViewer` and the same shape of proof:
   * seeding only one side would pass against a query that dropped the OR, and
   * seeding no stranger would pass against one that dropped the viewer filter
   * entirely — which is the whole security property here.
   */
  it('lists what the viewer sent AND received, and nothing of a stranger', async () => {
    const viewer = uuidv7();
    const counterparty = uuidv7();
    const stranger = uuidv7();
    const sent = `T${uuidv7()}`;
    const received = `T${uuidv7()}`;
    const unrelated = `T${uuidv7()}`;

    await insertSendAttribution(suite!.db, {
      address: sent,
      network: 'testnet',
      senderUserId: viewer,
      recipientUserId: counterparty,
      derivationIndex: 1,
    });
    await insertSendAttribution(suite!.db, {
      address: received,
      network: 'testnet',
      senderUserId: counterparty,
      recipientUserId: viewer,
      derivationIndex: 2,
    });
    await insertSendAttribution(suite!.db, {
      address: unrelated,
      network: 'testnet',
      senderUserId: stranger,
      recipientUserId: counterparty,
      derivationIndex: 3,
    });

    const rows = await listAttributionsForViewer(suite!.db, viewer, 'testnet');
    expect(rows.map((r) => r.address).sort()).toEqual([sent, received].sort());
  });

  /**
   * A wallet shows one network at a time. Without the network predicate a
   * testnet payment would surface in a mainnet balance, and the amounts are
   * not comparable.
   */
  it('scopes the viewer listing to one network', async () => {
    const viewer = uuidv7();
    const onTestnet = `T${uuidv7()}`;
    await insertSendAttribution(suite!.db, {
      address: onTestnet,
      network: 'testnet',
      senderUserId: viewer,
      recipientUserId: uuidv7(),
      derivationIndex: 1,
    });

    expect(await listAttributionsForViewer(suite!.db, viewer, 'mainnet')).toEqual([]);
    expect((await listAttributionsForViewer(suite!.db, viewer, 'testnet')).map((r) => r.address)).toEqual([onTestnet]);
  });
});
