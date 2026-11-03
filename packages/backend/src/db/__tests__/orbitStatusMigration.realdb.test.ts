/**
 * The 0019 data migration (`0043_orbit_payments_core_data.sql`), against rows
 * written in the PRE-0019 vocabulary.
 *
 * A database is migrated to `0041` only — the last migration before ADR 0019 —
 * then seeded the way the outgoing image wrote: every old status on its rail,
 * refunds, stored events in the old names and an endpoint subscribed to them.
 * The rest of the chain then runs over it, exactly as a deploy would, and every
 * row is checked for what it became. The constraints 0042 added `NOT VALID` are
 * VALIDATED by 0045 in the same run, so a conversion that left one row outside
 * them fails here rather than at a production deploy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { createTestDatabase, dropTestDatabase } from '@oxy.so/db/testing';
import { runMigrations } from '@oxy.so/db/migrate';
import { uuidv7 } from '@oxy.so/db';
import { MIGRATIONS_FOLDER } from '../migrate';
import { POSTGRES_TESTS_ENABLED, TEST_ADMIN_URL } from '../testDatabase';
import { testXpubFor } from '../../__tests__/helpers/gatewayTestDatabase';

const LAST_BEFORE_0019 = 41;

let databaseUrl: string | undefined;
let sql: postgres.Sql | undefined;
let partial: string | undefined;

const quiet = { info: () => undefined, debug: () => undefined };

function db(): postgres.Sql {
  if (!sql) throw new Error('no database');
  return sql;
}

interface Seeded {
  readonly id: string;
  readonly publicId: string;
}

/** An old-shape stored PaymentIntent, as 0036 left the wire. */
function oldIntentJson(
  publicId: string,
  status: string,
  rail: 'faircoin' | 'card',
  merchantInternalId: string,
) {
  return {
    id: publicId,
    object: 'payment_intent',
    livemode: false,
    status,
    rail,
    amount: '10000',
    currency: rail === 'card' ? 'EUR' : 'FAIR',
    network: rail === 'card' ? null : 'testnet',
    address: rail === 'card' ? null : `T${publicId}`,
    merchant_id: merchantInternalId,
    connected_account: null,
    txid: rail === 'card' ? null : 'f'.repeat(64),
    confirmations: rail === 'card' ? 0 : 3,
    client_secret: `${publicId}_secret_x`,
    metadata: { order: 'o1' },
    expires_at: 1_784_332_800,
    can_expire: false,
    created: 1_784_332_800,
    updated_at: 1_784_336_400,
  };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the ADR 0019 data migration', () => {
  const merchant = { id: uuidv7(), publicId: `merch_${uuidv7()}` };
  const rows: Record<string, Seeded> = {};

  async function seedIntent(
    key: string,
    rail: 'faircoin' | 'card',
    status: string,
    options: { txid?: boolean } = {},
  ): Promise<void> {
    const id = uuidv7();
    const publicId = `pi_${key}_${id.slice(-8)}`;
    rows[key] = { id, publicId };
    const chain = rail === 'faircoin';
    await db()`
      insert into payment_intents
        (id, public_id, status, rail, amount, currency, network, address, merchant_id,
         txid, confirmations, provider, provider_object_id, client_secret, idempotency_key,
         metadata, expires_at, created_at, updated_at)
      values
        (${id}, ${publicId}, ${status}, ${rail}, '10000', ${chain ? 'FAIR' : 'EUR'},
         ${chain ? 'testnet' : null}, ${chain ? `T${publicId}` : null}, ${merchant.id},
         ${options.txid ? 'f'.repeat(64) : null}, ${options.txid ? 3 : 0},
         ${chain ? null : 'stripe'}, ${chain ? null : `pi_stripe_${key}`},
         ${`${publicId}_secret_x`}, ${id}, '{"order":"o1"}'::jsonb,
         now() + interval '15 minutes', now() - interval '1 hour', now() - interval '30 minutes')`;
  }

  async function seedEvent(key: string, intentKey: string, type: string, object: object) {
    const intent = rows[intentKey];
    if (!intent) throw new Error(`no intent ${intentKey}`);
    const id = uuidv7();
    rows[key] = { id, publicId: `evt_${key}` };
    await db()`
      insert into events
        (id, public_id, merchant_id, type, api_version, data_object, payment_intent_id)
      values
        (${id}, ${`evt_${key}`}, ${merchant.id}, ${type}, '2026-11-03',
         ${db().json(object as never)}, ${intent.id})`;
  }

  async function intent(key: string) {
    const seeded = rows[key];
    if (!seeded) throw new Error(`no intent ${key}`);
    const [row] = await db()`
      select status, cancellation_reason, canceled_at, updated_at, amount_received,
             last_payment_error, txid
      from payment_intents where id = ${seeded.id}`;
    if (!row) throw new Error(`intent ${key} vanished`);
    return row;
  }

  async function storedEvent(key: string) {
    const seeded = rows[key];
    if (!seeded) throw new Error(`no event ${key}`);
    const [row] = await db()`select type, data_object from events where id = ${seeded.id}`;
    if (!row) throw new Error(`event ${key} vanished`);
    return row as { type: string; data_object: Record<string, unknown> };
  }

  beforeAll(async () => {
    // The chain up to 0037, from a copy of the folder whose journal stops there.
    partial = mkdtempSync(join(tmpdir(), 'peable-0019-'));
    cpSync(MIGRATIONS_FOLDER, partial, { recursive: true });
    const journalPath = join(partial, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= LAST_BEFORE_0019);
    writeFileSync(journalPath, JSON.stringify(journal));
    const folder = partial;

    databaseUrl = await createTestDatabase({
      adminUrl: TEST_ADMIN_URL,
      migrate: (url) =>
        runMigrations({
          databaseUrl: url,
          migrationsFolder: folder,
          extensions: [],
          run: 'all',
          dryRun: false,
          logger: quiet,
        }),
    });
    sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined });

    await db()`
      insert into merchants
        (id, public_id, oxy_app_id, environment, livemode, network, xpub, required_confirmations)
      values
        (${merchant.id}, ${merchant.publicId}, ${`app_${merchant.id}`}, 'development', false,
         'testnet', ${testXpubFor('testnet')}, 2)`;
    // An endpoint subscribed by the OLD names, and one to everything.
    for (const [publicId, enabled] of [
      [
        'we_named',
        [
          'payment_intent.settled',
          'payment_intent.refunded',
          'payment_intent.partially_refunded',
          'connected_account.updated',
        ],
      ],
      ['we_all', ['*']],
    ] as const) {
      await db()`
        insert into webhook_endpoints
          (id, public_id, merchant_id, url, enabled_events, metadata, api_version, secret, status)
        values
          (${uuidv7()}, ${publicId}, ${merchant.id}, 'https://merchant.example/hook',
           ${db().array([...enabled])}, '{}'::jsonb, '2026-11-03', 'whsec_x', 'enabled')`;
    }

    // Every pre-0019 status, on each rail it could hold.
    await seedIntent('fc_created', 'faircoin', 'created');
    await seedIntent('fc_awaiting', 'faircoin', 'awaiting_approval');
    await seedIntent('fc_approved', 'faircoin', 'approved');
    await seedIntent('fc_broadcast', 'faircoin', 'broadcast', { txid: true });
    await seedIntent('fc_confirming', 'faircoin', 'confirming', { txid: true });
    await seedIntent('fc_settled', 'faircoin', 'settled', { txid: true });
    await seedIntent('fc_failed', 'faircoin', 'failed', { txid: true });
    await seedIntent('fc_expired', 'faircoin', 'expired');
    await seedIntent('fc_rejected', 'faircoin', 'rejected');
    await seedIntent('card_created', 'card', 'created');
    await seedIntent('card_action', 'card', 'requires_action');
    await seedIntent('card_processing', 'card', 'processing');
    await seedIntent('card_settled', 'card', 'settled');
    await seedIntent('card_failed', 'card', 'failed');
    await seedIntent('card_partial', 'card', 'partially_refunded');
    await seedIntent('card_refunded', 'card', 'refunded');
    await seedIntent('card_expired', 'card', 'expired');
    await seedIntent('card_rejected', 'card', 'rejected');

    // The refund state the old statuses carried, as rows.
    for (const [key, amount] of [
      ['card_partial', '4000'],
      ['card_refunded', '10000'],
    ] as const) {
      const target = rows[key];
      if (!target) throw new Error('missing');
      await db()`
        insert into refunds
          (id, public_id, merchant_id, payment_intent_id, external_ref, origin, amount,
           currency, status, provider, provider_object_id)
        values
          (${uuidv7()}, ${`re_${key}`}, ${merchant.id}, ${target.id}, ${`ref_${key}`},
           'merchant', ${amount}, 'EUR', 'succeeded', 'stripe', ${`re_stripe_${key}`})`;
    }

    // Stored envelopes in the old names.
    await seedEvent(
      'ev_confirming',
      'fc_confirming',
      'payment_intent.confirming',
      oldIntentJson(rows.fc_confirming?.publicId ?? '', 'confirming', 'faircoin', merchant.id),
    );
    await seedEvent(
      'ev_settled',
      'card_settled',
      'payment_intent.settled',
      oldIntentJson(rows.card_settled?.publicId ?? '', 'settled', 'card', merchant.id),
    );
    await seedEvent(
      'ev_failed',
      'fc_failed',
      'payment_intent.failed',
      oldIntentJson(rows.fc_failed?.publicId ?? '', 'failed', 'faircoin', merchant.id),
    );
    await seedEvent(
      'ev_expired',
      'fc_expired',
      'payment_intent.expired',
      oldIntentJson(rows.fc_expired?.publicId ?? '', 'expired', 'faircoin', merchant.id),
    );
    await seedEvent(
      'ev_partial',
      'card_partial',
      'payment_intent.partially_refunded',
      oldIntentJson(rows.card_partial?.publicId ?? '', 'partially_refunded', 'card', merchant.id),
    );
    await seedEvent('ev_disputed', 'card_settled', 'payment_intent.disputed', {
      id: 'dp_x',
      object: 'dispute',
      livemode: false,
      payment_intent: rows.card_settled?.publicId,
      amount: '10000',
      currency: 'EUR',
      status: 'needs_response',
    });
    await db()`
      insert into idempotency_keys
        (id, merchant_id, key, method, path, request_hash, status, response_status,
         response_body, expires_at)
      values
        (${uuidv7()}, ${merchant.id}, 'stale-key', 'POST', '/v1/payment_intents',
         ${'a'.repeat(64)}, 'completed', 201, '{"status":"created"}'::jsonb,
         now() + interval '1 day')`;

    // The rest of the chain, over the old rows — 0042 through 0045.
    await runMigrations({
      databaseUrl,
      migrationsFolder: MIGRATIONS_FOLDER,
      extensions: [],
      run: 'all',
      dryRun: false,
      logger: quiet,
    });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (databaseUrl) await dropTestDatabase(databaseUrl);
    if (partial) rmSync(partial, { recursive: true, force: true });
  });

  it('converts every FairCoin status', async () => {
    for (const key of ['fc_created', 'fc_awaiting', 'fc_approved']) {
      expect([key, (await intent(key)).status]).toEqual([key, 'requires_action']);
    }
    for (const key of ['fc_broadcast', 'fc_confirming']) {
      const row = await intent(key);
      expect([key, row.status, row.txid]).toEqual([key, 'processing', 'f'.repeat(64)]);
    }
    const settled = await intent('fc_settled');
    expect(settled.status).toBe('succeeded');
    expect(settled.amount_received).toBe('10000');

    const underpaid = await intent('fc_failed');
    expect(underpaid.status).toBe('canceled');
    expect(underpaid.cancellation_reason).toBe('underpaid');
    expect(underpaid.last_payment_error.code).toBe('payment_underpaid');
    expect(underpaid.canceled_at).toEqual(underpaid.updated_at);

    const expired = await intent('fc_expired');
    expect([expired.status, expired.cancellation_reason]).toEqual(['canceled', 'abandoned']);
    const rejected = await intent('fc_rejected');
    expect([rejected.status, rejected.cancellation_reason]).toEqual(['canceled', null]);
    expect(rejected.canceled_at).not.toBeNull();
  });

  it('converts every card status, carrying refunds into amounts', async () => {
    expect((await intent('card_created')).status).toBe('requires_payment_method');
    expect((await intent('card_action')).status).toBe('requires_action');
    expect((await intent('card_processing')).status).toBe('processing');

    const declined = await intent('card_failed');
    expect(declined.status).toBe('requires_payment_method');
    expect(declined.last_payment_error.type).toBe('card_error');
    expect(declined.cancellation_reason).toBeNull();

    for (const key of ['card_settled', 'card_partial', 'card_refunded']) {
      const row = await intent(key);
      expect([key, row.status, row.amount_received]).toEqual([key, 'succeeded', '10000']);
    }
    const [refunded] = await db()`
      select coalesce(sum(r.amount::numeric), 0)::text as total from refunds r
      join payment_intents p on p.id = r.payment_intent_id
      where p.id = ${rows.card_partial?.id ?? ''} and r.status = 'succeeded'`;
    expect(refunded?.total).toBe('4000');

    expect((await intent('card_expired')).cancellation_reason).toBe('abandoned');
    expect((await intent('card_rejected')).status).toBe('canceled');
  });

  it('gives every succeeded card payment exactly one charge, and no other payment one', async () => {
    const charged = await db()`
      select p.public_id from charges c join payment_intents p on p.id = c.payment_intent_id`;
    expect(charged.map((row) => String(row.public_id)).sort()).toEqual(
      [rows.card_settled, rows.card_partial, rows.card_refunded]
        .map((row) => String(row?.publicId))
        .sort(),
    );
    const [charge] = await db()`select public_id, id, amount_captured from charges limit 1`;
    expect(String(charge?.public_id)).toMatch(/^ch_[0-9a-f]{24}$/);
    expect(String(charge?.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    expect(charge?.amount_captured).toBe('10000');
  });

  it('renames stored events and rewrites their objects to the 0019 wire', async () => {
    const confirming = await storedEvent('ev_confirming');
    expect(confirming.type).toBe('payment_intent.processing');
    const object = confirming.data_object;
    expect(object.status).toBe('processing');
    expect(object.merchant_id).toBe(merchant.publicId);
    expect(object.faircoin).toEqual({
      network: 'testnet',
      address: `T${rows.fc_confirming?.publicId}`,
      txid: 'f'.repeat(64),
      confirmations: 3,
      required_confirmations: 2,
    });
    expect('address' in object).toBe(false);
    expect('txid' in object).toBe(false);
    expect(object.metadata).toEqual({ order: 'o1' });

    const settled = await storedEvent('ev_settled');
    expect(settled.type).toBe('payment_intent.succeeded');
    expect(settled.data_object.status).toBe('succeeded');
    expect(settled.data_object.amount_received).toBe('10000');
    expect(String(settled.data_object.latest_charge)).toMatch(/^ch_/);

    const failed = await storedEvent('ev_failed');
    expect(failed.type).toBe('payment_intent.payment_failed');
    expect(failed.data_object.cancellation_reason).toBe('underpaid');

    const expired = await storedEvent('ev_expired');
    expect(expired.type).toBe('payment_intent.canceled');
    expect(expired.data_object.cancellation_reason).toBe('abandoned');

    const partial = await storedEvent('ev_partial');
    expect(partial.type).toBe('charge.refunded');
    expect(partial.data_object.object).toBe('charge');
    expect(partial.data_object.amount_refunded).toBe('4000');
    expect(partial.data_object.refunded).toBe(false);
    expect(partial.data_object.payment_intent).toBe(rows.card_partial?.publicId);

    const disputed = await storedEvent('ev_disputed');
    expect(disputed.type).toBe('charge.dispute.created');
    expect(disputed.data_object.object).toBe('dispute');
  });

  it('keeps an endpoint subscribed to the same moments, under the new names', async () => {
    const endpoints =
      await db()`select public_id, enabled_events from webhook_endpoints order by public_id`;
    expect(endpoints.map((row) => [row.public_id, row.enabled_events])).toEqual([
      ['we_all', ['*']],
      ['we_named', ['charge.refunded', 'connected_account.updated', 'payment_intent.succeeded']],
    ]);
  });

  it('empties the stored idempotent answers of the retired wire', async () => {
    expect(await db()`select id from idempotency_keys`).toHaveLength(0);
  });

  it('leaves every constraint validated', async () => {
    const unvalidated = await db()`
      select conname from pg_constraint
      where conrelid in ('payment_intents'::regclass, 'events'::regclass, 'webhook_endpoints'::regclass)
        and not convalidated`;
    expect(unvalidated.map((row) => row.conname)).toEqual([]);
  });
});
