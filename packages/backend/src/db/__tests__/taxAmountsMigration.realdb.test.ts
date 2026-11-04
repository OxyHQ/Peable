/**
 * The tax amounts data migration (`0075_tax_amounts_strings.sql` and its
 * post-phase `0076`), against rows written in the number-amount wire.
 *
 * A database is migrated to `0074` only — the last migration before the cut —
 * then seeded the way the outgoing image wrote: a calculation, a reversal and a
 * stored idempotent answer, with amounts beyond
 * `Number.MAX_SAFE_INTEGER` spelled as exact JSON numbers. The rest of the
 * chain then runs over them, exactly as a deploy would, and every value is
 * checked digit for digit.
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

const LAST_BEFORE_THE_CUT = 74;
/** 2^53 + 1: a JS number would read it as 2^53. */
const BEYOND_SAFE = '9007199254740993';

let databaseUrl: string | undefined;
let sql: postgres.Sql | undefined;
let partial: string | undefined;

const quiet = { info: () => undefined, debug: () => undefined };

function db(): postgres.Sql {
  if (!sql) throw new Error('no database');
  return sql;
}

/** A calculation line as the number wire stored it (`raw` keeps big numbers exact). */
const line = (amount: string, tax: string, net: string) => `{
  "reference": "plan", "quantity": 3, "tax_code": "txcd_10103000", "tax_behavior": "exclusive",
  "amount": ${amount}, "amount_tax": ${tax}, "amount_net": ${net},
  "breakdown": [{
    "country": "DE", "state": null, "level": "country", "display_name": "VAT",
    "tax_type": "vat", "rate_percentage": "19.0", "taxable_amount": ${net}, "amount": ${tax},
    "inclusive": false, "taxability_reason": "standard_rated"
  }]
}`;

const calculationJson = (publicId: string) => `{
  "object": "tax.calculation", "id": "${publicId}", "currency": "EUR",
  "collection": "not_registered", "registration_id": null, "provider": null,
  "provider_calculation_ref": null, "customer_location_evidence_id": "taxloc_x",
  "country": "DE", "state": null,
  "amount_total": ${BEYOND_SAFE}, "amount_net": ${BEYOND_SAFE},
  "tax_amount_exclusive": 0, "tax_amount_inclusive": 0,
  "line_items": [${line(BEYOND_SAFE, '0', BEYOND_SAFE)}],
  "tax_date": 1793750400, "created": 1793750400, "expires_at": 1793836800, "livemode": false
}`;

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the tax amounts data migration', () => {
  const merchant = { id: uuidv7(), publicId: `merch_${uuidv7()}` };
  const calculation = { id: uuidv7(), publicId: 'taxcalc_number' };
  const original = uuidv7();
  const reversal = uuidv7();
  const replay = uuidv7();

  beforeAll(async () => {
    partial = mkdtempSync(join(tmpdir(), 'peable-tax-amounts-'));
    cpSync(MIGRATIONS_FOLDER, partial, { recursive: true });
    const journalPath = join(partial, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= LAST_BEFORE_THE_CUT);
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
    const evidence = uuidv7();
    await db()`
      insert into tax_location_evidence
        (id, public_id, merchant_id, customer_ref, status, rule, country, items, observed_at, expires_at)
      values
        (${evidence}, 'taxloc_x', ${merchant.id}, 'payer', 'sufficient', 'single', 'DE',
         '[]'::jsonb, now(), now() + interval '1 day')`;
    await db().unsafe(
      `insert into tax_calculations
         (id, public_id, merchant_id, evidence_id, collection, currency, country, result, expires_at)
       values ($1, $2, $3, $4, 'not_registered', 'EUR', 'DE', $5::text::jsonb, now() + interval '1 day')`,
      [
        calculation.id,
        calculation.publicId,
        merchant.id,
        evidence,
        calculationJson(calculation.publicId),
      ],
    );
    await db()`
      insert into tax_transactions
        (id, public_id, merchant_id, calculation_id, reference, rail, committed_at)
      values (${original}, 'taxtxn_original', ${merchant.id}, ${calculation.id}, 'order', 'faircoin', now())`;
    await db().unsafe(
      `insert into tax_transactions
         (id, public_id, merchant_id, calculation_id, reference, rail, committed_at,
          reversal_of_id, reversal)
       values ($1, 'taxtxn_reversal', $2, $3, 'refund', 'faircoin', now(), $4, $5::text::jsonb)`,
      [
        reversal,
        merchant.id,
        calculation.id,
        original,
        `{"amount_total": -${BEYOND_SAFE}, "amount_net": -${BEYOND_SAFE}, "tax_amount": 0,
          "line_items": [${line(`-${BEYOND_SAFE}`, '0', `-${BEYOND_SAFE}`)}]}`,
      ],
    );
    await db().unsafe(
      `insert into idempotency_keys
         (id, merchant_id, key, method, path, request_hash, status, response_status,
          response_body, expires_at)
       values ($1, $2, 'calc-key', 'POST', '/v1/tax/calculations', $3, 'completed', 201,
               $4::text::jsonb, now() + interval '1 day')`,
      [replay, merchant.id, 'b'.repeat(64), calculationJson('taxcalc_replayed')],
    );

    // The rest of the chain over the old rows: 0075 (pre), then 0076 (post).
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

  it('spells every calculation amount as the exact integer string, and nothing else', async () => {
    const [row] = await db()`select result from tax_calculations where id = ${calculation.id}`;
    const result = row?.result as Record<string, unknown> & {
      line_items: Record<string, unknown>[];
    };
    expect(result).toMatchObject({
      amount_total: BEYOND_SAFE,
      amount_net: BEYOND_SAFE,
      tax_amount_exclusive: '0',
      tax_amount_inclusive: '0',
      tax_date: 1793750400,
      expires_at: 1793836800,
    });
    expect(result.line_items[0]).toMatchObject({
      quantity: 3,
      amount: BEYOND_SAFE,
      amount_tax: '0',
      amount_net: BEYOND_SAFE,
      breakdown: [{ taxable_amount: BEYOND_SAFE, amount: '0', rate_percentage: '19.0' }],
    });
  });

  it('keeps a reversal negative and exact', async () => {
    const [row] = await db()`select reversal from tax_transactions where id = ${reversal}`;
    expect(row?.reversal).toMatchObject({
      amount_total: `-${BEYOND_SAFE}`,
      amount_net: `-${BEYOND_SAFE}`,
      tax_amount: '0',
      line_items: [
        { amount: `-${BEYOND_SAFE}`, breakdown: [{ taxable_amount: `-${BEYOND_SAFE}` }] },
      ],
    });
    const [sale] = await db()`select reversal from tax_transactions where id = ${original}`;
    expect(sale?.reversal).toBeNull();
  });

  it('rewrites a stored idempotent answer so a replay speaks the one wire', async () => {
    const [row] = await db()`select response_body from idempotency_keys where id = ${replay}`;
    expect(row?.response_body).toMatchObject({ id: 'taxcalc_replayed', amount_total: BEYOND_SAFE });
  });

  it('drops its functions once the post phase has run', async () => {
    const functions = await db()`
      select proname from pg_proc where proname like 'peable_tax_amount%'`;
    expect(functions.map((row) => row.proname)).toEqual([]);
  });
});
