import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findIdColumnViolations,
  findImplicitWholeRowReads,
  findSchemaInvariantViolations,
} from '@oxy.so/db/assert';
import { phaseMarkerLine } from '@oxy.so/db/migrate';
import { PROTECTED_COLUMNS } from '../protectedColumns';
import {
  checkoutSessions,
  connectedAccounts,
  merchants,
  paymentIntents,
  paymentLinks,
  providerEvents,
  refunds,
  socialReceiveCursors,
  socialSendAttributions,
  transfers,
  webhookDeliveries,
} from '../schema';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';

/**
 * The schema-wide gates: conventions one table can break on its own without
 * anything else noticing, checked across every table at once — and, for the
 * database half, against the DDL that actually landed rather than the
 * TypeScript that was meant to produce it.
 */

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(BACKEND_ROOT, 'db', 'migrations');

const ALL_TABLES = [
  checkoutSessions,
  connectedAccounts,
  merchants,
  paymentIntents,
  paymentLinks,
  providerEvents,
  refunds,
  socialReceiveCursors,
  socialSendAttributions,
  transfers,
  webhookDeliveries,
] as const;

let suite: SuiteDatabase | undefined;

describe('the real-database suites', () => {
  /**
   * The discriminator for every `describe.skipIf(!POSTGRES_TESTS_ENABLED)` in
   * this package.
   *
   * A skipped suite and a passing suite are indistinguishable in a summary
   * line, so "0 fail" says nothing about whether the database gates ran at all
   * — which is exactly the shape of a check that cannot fail. This test ALWAYS
   * runs, and turns a missing `TEST_DATABASE_URL` in CI into a red build rather
   * than a quiet green one. Locally it stays silent, so a developer without a
   * container is not blocked.
   */
  it('are not silently skipped in CI', () => {
    if (!process.env.CI) return;
    expect([process.env.CI, POSTGRES_TESTS_ENABLED]).toEqual([process.env.CI, true]);
  });
});

describe('id-column classification', () => {
  /**
   * Every `*_id` column is either a primary key, a declared foreign key, or
   * named here with the reason it will never carry one. A new one that is none
   * of those is a column nobody has decided about.
   *
   * Every entry below points OUT of this database. Oxy owns identity, so a
   * foreign key to a user is not merely absent — it is unrepresentable.
   */
  it('accounts for every id-shaped column', () => {
    const violations = findIdColumnViolations({
      tables: ALL_TABLES,
      deferred: [],
      withoutForeignKey: [
        // The four public ids are this row's OWN external identifier, not a
        // reference to another row. They end in `_id` and are caught by the
        // scan for that reason alone.
        {
          column: 'merchants.public_id',
          reason: "this row's own merch_… identifier, not a reference",
        },
        {
          column: 'payment_intents.public_id',
          reason: "this row's own pi_… identifier, not a reference",
        },
        {
          column: 'checkout_sessions.public_id',
          reason: "this row's own cs_… identifier, not a reference",
        },
        {
          column: 'payment_links.public_id',
          reason: "this row's own link_… identifier, not a reference",
        },
        {
          column: 'merchants.oxy_app_id',
          reason: "an Oxy Application's id — Oxy owns the application registry, not this database",
        },
        {
          column: 'merchants.avatar_file_id',
          reason: "a bare Oxy file id, resolved through the SDK's media chokepoint",
        },
        {
          column: 'social_receive_cursors.oxy_user_id',
          reason: 'an Oxy user id — Oxy owns identity',
        },
        {
          column: 'social_send_attributions.sender_user_id',
          reason: 'an Oxy user id — Oxy owns identity',
        },
        {
          column: 'social_send_attributions.recipient_user_id',
          reason: 'an Oxy user id — Oxy owns identity',
        },
        {
          column: 'checkout_sessions.oxy_app_id',
          reason:
            "an Oxy Application's id; its agreement with the merchant's is carried by checkout_sessions_merchant_identity_fkey",
        },
        {
          column: 'payment_links.oxy_app_id',
          reason:
            "an Oxy Application's id; its agreement with the merchant's is carried by payment_links_merchant_identity_fkey",
        },
        {
          column: 'webhook_deliveries.event_id',
          reason: 'the evt_… envelope id that was signed and sent; events are never persisted',
        },
        // `provider_events` holds a PROVIDER's numbering, not this database's.
        // None of these can carry a foreign key: the rows they name live at
        // Stripe, and a reference to them is not expressible here.
        {
          column: 'provider_events.provider_event_id',
          reason: "the provider's own evt_… id — their numbering, not ours",
        },
        {
          column: 'provider_events.provider_account_id',
          reason: "the provider's own acct_… id; NULL for platform scope",
        },
        {
          column: 'provider_events.object_ids',
          reason: 'a jsonb map of the provider object ids an event refers to, under their names',
        },
        {
          column: 'refunds.public_id',
          reason: "this row's own re_… identifier, not a reference",
        },
        {
          column: 'refunds.provider_object_id',
          reason:
            "the provider's own re_…; uniqueness is held by refunds_provider_object_key and the row it names is at the provider",
        },
        {
          column: 'connected_accounts.public_id',
          reason: "this row's own ca_… identifier, not a reference",
        },
        {
          column: 'transfers.public_id',
          reason: "this row's own tr_… identifier, not a reference",
        },
        {
          column: 'connected_accounts.provider_account_id',
          reason:
            "the provider's own acct_…; a reference is not expressible because the row is at the provider, and uniqueness is held by connected_accounts_provider_account_id_key",
        },
        {
          column: 'transfers.provider_object_id',
          reason:
            "the provider's own tr_…; uniqueness is held by transfers_provider_object_key and the row it names is at the provider",
        },
        {
          column: 'transfers.source_payment_object_id',
          reason:
            "the provider's id for the CHARGE this transfer draws on — their numbering, and what makes the transfer wait for the charge's funds",
        },
        {
          column: 'payment_intents.provider_object_id',
          reason:
            "the provider's own id for the object that moves the money; uniqueness is held by payment_intents_provider_object_key, and a reference is not expressible because the row is at the provider",
        },
      ],
      minimumTables: ALL_TABLES.length,
    });

    expect(violations).toEqual([]);
  });
});

describe('protected columns', () => {
  /**
   * `publicColumns` cannot defend against not being called. A bare `.select()`
   * and the relational `db.query.<table>` API both return every column,
   * including whatever the registry withholds, without naming one.
   */
  it('has no implicit whole-row reads', async () => {
    const violations = await findImplicitWholeRowReads({
      sourceDir: BACKEND_ROOT,
      registry: PROTECTED_COLUMNS,
    });

    expect(violations).toEqual([]);
  });
});

describe('migration files', () => {
  async function migrationFiles(): Promise<string[]> {
    const entries = await readdir(MIGRATIONS_DIR);
    return entries.filter((entry) => entry.endsWith('.sql')).sort();
  }

  it('declares a deploy phase on every migration', async () => {
    const files = await migrationFiles();
    // Vacuity floor: an empty directory would pass every assertion below by
    // examining nothing, and this suite's whole job is to examine them.
    expect(files.length).toBeGreaterThanOrEqual(1);

    for (const file of files) {
      const contents = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const markers = [phaseMarkerLine('pre'), phaseMarkerLine('post')].filter((marker) =>
        contents.includes(marker)
      );
      expect([file, markers.length]).toEqual([file, 1]);
    }
  });

  /**
   * No bound parameter in any DDL.
   *
   * A value interpolated into a drizzle `sql` template becomes a bound
   * parameter, and drizzle-kit renders it into the migration as the literal
   * text `$1`. A CHECK constraint cannot carry one, so the migration fails at
   * apply time — but `tsc` is clean and `drizzle-kit generate` reports success,
   * so nothing before this catches it. Measured: the first generated migration
   * here contained `CHECK (next_derivation_index >= $1)` because the bound was
   * a named constant rather than a literal written in the template.
   */
  it('contains no bound parameters', async () => {
    const files = await migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);

    const offenders: string[] = [];
    for (const file of files) {
      const contents = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      for (const line of contents.split('\n')) {
        if (/\$\d/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the migrated database', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  it('satisfies every schema-wide invariant', async () => {
    const violations = await findSchemaInvariantViolations(suite!.db, {
      minimumTables: ALL_TABLES.length,
      // 92 columns across the seven tables at the time of writing. A floor, not
      // an equality: it must not silently drop to zero on a broken catalogue
      // query, and it must not need editing for every added column.
      minimumColumns: 80,
    });

    expect(violations).toEqual([]);
  });
});
