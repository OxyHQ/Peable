/**
 * `provider_events` against a real server.
 *
 * Every assertion here is about something a mock cannot have: a unique
 * constraint's NULL semantics, a CHECK refusing a write, and the behaviour of
 * two concurrent inserts. A mocked insert accepts all of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { isCheckViolation } from '@oxy.so/db';
import {
  findProviderEventById,
  findProviderEventByIdentity,
  findUnprocessedProviderEvents,
  insertProviderEvent,
  markProviderEventFailed,
  markProviderEventProcessed,
} from '../providers/providerEventRepository';
import { providerEvents } from '../schema';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

let suite: SuiteDatabase | undefined;

/** One well-formed delivery, with only the identity varying per case. */
function delivery(overrides: Partial<Parameters<typeof insertProviderEvent>[1]> = {}) {
  return {
    provider: 'stripe',
    providerEventId: 'evt_default',
    providerAccountId: null,
    type: 'payment_intent.succeeded',
    livemode: false,
    apiVersion: '2026-07-29.dahlia',
    objectIds: { payment_intent: 'pi_1' },
    payload: { id: 'evt_default', object: 'event' },
    ...overrides,
  };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('provider_events', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  it('stores a delivery and reads it back whole', async () => {
    const id = await insertProviderEvent(
      suite!.db,
      delivery({ providerEventId: 'evt_store', objectIds: { payment_intent: 'pi_store' } })
    );
    expect(id).toBeTruthy();

    const row = await findProviderEventById(suite!.db, id!);
    expect(row?.providerEventId).toBe('evt_store');
    expect(row?.objectIds).toEqual({ payment_intent: 'pi_store' });
    // Received and not yet interpreted — the normal state a moment after ingress.
    expect(row?.processedAt).toBeNull();
    expect(row?.processingError).toBeNull();
  });

  /**
   * The retry, on the scope that has no account.
   *
   * This is the case a plain unique index gets WRONG: PostgreSQL treats every
   * NULL as distinct, so `('stripe', NULL, 'evt_1')` twice is two rows unless
   * the constraint says `NULLS NOT DISTINCT`. Measured on a real server before
   * the schema was written this way, and this test is what keeps it that way —
   * remove `.nullsNotDistinct()` and this goes red.
   */
  it('converges on a retry of a PLATFORM-scope delivery, which carries no account', async () => {
    const first = await insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_plat' }));
    const second = await insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_plat' }));

    expect(first).toBeTruthy();
    expect(second).toBeNull();

    const rows = await suite!.db
      .select({ id: providerEvents.id })
      .from(providerEvents)
      .where(eq(providerEvents.providerEventId, 'evt_plat'));
    expect(rows).toHaveLength(1);
  });

  it('converges on a retry of a CONNECT-scope delivery', async () => {
    const first = await insertProviderEvent(
      suite!.db,
      delivery({ providerEventId: 'evt_conn', providerAccountId: 'acct_1' })
    );
    const second = await insertProviderEvent(
      suite!.db,
      delivery({ providerEventId: 'evt_conn', providerAccountId: 'acct_1' })
    );

    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  /**
   * The other direction, and the reason the account is IN the key rather than
   * beside it: two connected accounts can be told about the same object, and a
   * platform-scope event can share an id space with a connect-scope one. Folding
   * them together would drop a delivery nobody ever sees again.
   */
  it('keeps deliveries to different scopes apart even when the event id matches', async () => {
    const platform = await insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_both' }));
    const connectA = await insertProviderEvent(
      suite!.db,
      delivery({ providerEventId: 'evt_both', providerAccountId: 'acct_a' })
    );
    const connectB = await insertProviderEvent(
      suite!.db,
      delivery({ providerEventId: 'evt_both', providerAccountId: 'acct_b' })
    );

    expect(platform).toBeTruthy();
    expect(connectA).toBeTruthy();
    expect(connectB).toBeTruthy();
    expect(new Set([platform, connectA, connectB]).size).toBe(3);
  });

  /**
   * The race the constraint exists for. Two deliveries of the same event in
   * flight at once — which is precisely what a provider retry looks like when
   * the first response was slow rather than lost. Exactly one wins; the other
   * gets `null` rather than an exception.
   */
  it('lets exactly one of two CONCURRENT inserts win', async () => {
    const results = await Promise.all([
      insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_race' })),
      insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_race' })),
      insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_race' })),
    ]);

    expect(results.filter((id) => id !== null)).toHaveLength(1);
    expect(results.filter((id) => id === null)).toHaveLength(2);
  });

  /**
   * `IS NOT DISTINCT FROM`, not `=`. A platform-scope lookup passes NULL, and
   * `null = null` is NULL in SQL — an `eq` here would never match the very rows
   * the platform endpoint writes, so a support query for a real event would
   * answer "we never received it".
   */
  it('finds a platform-scope event by its identity, NULL account and all', async () => {
    await insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_lookup' }));

    const found = await findProviderEventByIdentity(suite!.db, 'stripe', null, 'evt_lookup');
    expect(found?.providerEventId).toBe('evt_lookup');

    // ...and the connect-scope lookup for the same id finds nothing.
    const wrongScope = await findProviderEventByIdentity(
      suite!.db,
      'stripe',
      'acct_nope',
      'evt_lookup'
    );
    expect(wrongScope).toBeNull();
  });

  it('refuses a provider the closed set does not name', async () => {
    let raised: unknown;
    try {
      await insertProviderEvent(
        suite!.db,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        delivery({ provider: 'paypal', providerEventId: 'evt_paypal' })
      );
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'provider_events_provider_check')).toBe(true);
  });

  it('refuses a payload that is not a JSON object', async () => {
    let raised: unknown;
    try {
      await insertProviderEvent(
        suite!.db,
        delivery({
          providerEventId: 'evt_scalar',
          payload: 'not an object' as unknown as Record<string, unknown>,
        })
      );
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'provider_events_payload_object_check')).toBe(true);
  });

  it('serves the drain unprocessed rows oldest first, and drops them once handled', async () => {
    const older = await insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_drain_1' }));
    const newer = await insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_drain_2' }));

    const pending = await findUnprocessedProviderEvents(suite!.db, 100);
    const ids = pending.map((row) => row.id);
    // Scoped to the two rows this case owns: the suite database is shared with
    // the other cases in this file, which leave unprocessed rows of their own.
    expect(ids.indexOf(older!)).toBeLessThan(ids.indexOf(newer!));

    await markProviderEventProcessed(suite!.db, older!);
    const after = await findUnprocessedProviderEvents(suite!.db, 100);
    expect(after.map((row) => row.id)).not.toContain(older!);
    expect(after.map((row) => row.id)).toContain(newer!);
  });

  /**
   * A failure LEAVES the event in the drain's set — `processed_at` stays NULL —
   * and a later success clears the error. An event that failed once and then
   * succeeded must not keep reading as broken in an operator surface.
   */
  it('records a failure without removing the event from the drain, and clears it on success', async () => {
    const id = await insertProviderEvent(suite!.db, delivery({ providerEventId: 'evt_fail' }));

    await markProviderEventFailed(suite!.db, id!, 'downstream refused');
    const failed = await findProviderEventById(suite!.db, id!);
    expect(failed?.processingError).toBe('downstream refused');
    expect(failed?.processedAt).toBeNull();
    expect((await findUnprocessedProviderEvents(suite!.db, 100)).map((row) => row.id)).toContain(
      id!
    );

    await markProviderEventProcessed(suite!.db, id!);
    const done = await findProviderEventById(suite!.db, id!);
    expect(done?.processingError).toBeNull();
    expect(done?.processedAt).toBeInstanceOf(Date);
  });
});
