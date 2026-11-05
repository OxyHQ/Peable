/**
 * A `post` migration in front of a `pre` one blocks the whole release.
 *
 * ## What this caught, after it had already happened
 *
 * `planMigrationRun` defers everything from the first pending `post` migration
 * onwards, then REFUSES the run if any deferred entry is a `pre` — because
 * applying that later `pre` would mean applying the `post` in front of it
 * first, and the ledger records progress as a high-water mark and cannot skip
 * one. Its own words, from the migrator task that failed in production:
 *
 * > `0012_stormy_valkyrie` is a pre-deploy migration queued behind the
 * > post-deploy migration `0011_magical_cyclops`, which is not applied yet.
 *
 * Every deploy after that file merged failed at `Migrate (pre)` with a green
 * build, so the signal was three steps into a workflow nobody reads when it
 * goes well, on a repository whose tests all passed. This turns the same shape
 * into a red build, which is where it costs a minute instead of a release.
 *
 * ## The rule, and why it is stated over the journal rather than per file
 *
 * A single migration is never wrong on its own — `post` is the CORRECT phase
 * for a constraint that the old image would violate. It becomes wrong only in
 * the company it keeps, and only the ordered journal shows that. So:
 *
 * **A `post` migration must be the last entry in the journal.** Anything added
 * after it either has to be `post` too, or the `post` has to become `pre` and
 * carry the rollout-window risk explicitly (which is what `0011` does, and says
 * so in its own header).
 *
 * `SHIPPED_BEFORE` is the escape, and it is an escape from history rather than
 * from the rule: once a `post` has actually been applied in production it is no
 * longer pending, so it cannot strand anything, and a later `pre` is fine. That
 * is only ever knowable from outside the repository, which is why it is a
 * hand-maintained list with a reason per entry and not a heuristic.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

/**
 * `post` migrations already applied in production, so no longer pending and
 * unable to strand anything queued behind them.
 *
 * Adding to this list is a claim about the production ledger, not about the
 * repository. Verify it — the migrator names the first stranded pair when it
 * refuses — before writing a tag here.
 */
const SHIPPED_BEFORE: Record<string, string> = {
  // Applied well before `0010` was authored; the migrator confirmed it by
  // naming `0011`/`0012` as the stranded pair and not this one.
  '0009_fuzzy_misty_knight': 'applied in production before 0010 existed',
  // The contract half of events and webhook endpoints (ADR 0014 D4) ships in
  // its own release (#194), deployed before ADR 0019's `0042`–`0045` exist.
  '0041_drop_merchant_webhook_columns': 'released with #194 before 0042 (ADR 0019) was authored',
  // ADR 0019's validate half ships in its own release (#195), deployed before
  // the catalog's `0046`–`0047` (ADR 0018) exist.
  '0045_orbit_payments_core_validate': 'released with #195 before 0046 (catalog) was authored',
  // The catalog's validation half ships with #196; it must be DEPLOYED (its
  // post phase applied) before the request-log migration merges.
  '0047_catalog_validate': 'released with #196; deployed before 0048 (request logs) merges',
  // Phase 2b's validate half ships with #199; it must be DEPLOYED (its post
  // phase applied) before Orbit money's `0052`–`0057` (ADR 0015) merge.
  '0051_orbit_disputes_methods_validate':
    'released with #199; deployed before 0052 (Orbit money) merges',
  // Orbit money's contract half ships with #200; it must be DEPLOYED (its post
  // phase applied) before checkout v2 (Orbit Phase 3) merges behind it.
  '0057_orbit_money_contract': 'released with #200; deployed before checkout v2 merges',
  // Checkout v2's data half shipped with #202, whose deploy (1f247b9) applied
  // its post phase in production before search and report runs' `0062`–`0064`.
  '0061_checkout_v2_data': 'released with #202; applied in production by the 1f247b9 deploy',
  // Search and report runs' validate half ships with #203; it must be DEPLOYED
  // (its post phase applied) before the billing engine's `0065`–`0066` (ADR
  // 0018) merge.
  '0064_orbit_search_reporting_validate':
    'released with #203; deployed before 0065 (billing engine) merges',
  // The billing engine's validate half ships with #206; it must be DEPLOYED
  // (its post phase applied) before the report types' `0067`–`0068` merge.
  '0066_billing_engine_validate': 'released with #206; deployed before 0067 (report types) merges',
  // The report types' validate half ships with #205; it must be DEPLOYED (its
  // post phase applied) before provider events' arrival order (`0069`–`0072`)
  // merges.
  '0068_report_types_itemized_validate':
    'released with #205; deployed before 0069 (provider event arrival order) merges',
  // Provider events' arrival-order validate half ships with #208; it must be
  // DEPLOYED (its post phase applied) before business compliance's
  // `0073`–`0074` (ADR 0020) merge.
  '0072_provider_events_received_seq_validate':
    'released with #208; deployed before 0073 (tax compliance) merges',
  // Business compliance's validate half shipped with #204, whose deploy
  // (0ee84a3e) applied its post phase in production before the tax amounts'
  // `0075`–`0076` (ADR 0014 D1) existed.
  '0074_tax_compliance_validate':
    'released with #204; applied in production by the 0ee84a3e deploy',
  // The tax amounts' settle half is applied in production: a read-only ledger
  // probe on 2026-11-04 counted 77 rows (`0000`–`0076`) before subscription
  // adoption's `0077`–`0078` (ADR 0018 §7) existed.
  '0076_tax_amounts_strings_settle':
    'applied in production; ledger read 2026-11-04 held 0000–0076 before 0077 was authored',
  // Subscription adoption's validate half shipped with #222, whose deploy
  // (bfef755d) applied it: a read-only ledger probe counted 79 rows and the
  // CHECK `convalidated` before the proxy migration's `0079` merged.
  '0078_subscription_adoption_validate':
    'released with #222; applied in production by the bfef755d deploy',
  // Retiring the Stripe-Billing proxy (#224) is applied in production: a
  // read-only ledger probe on 2026-11-05 counted 83 rows (`0000`–`0082`, ids
  // 1–83) before the webhook endpoint `url_refused` migrations `0083`–`0084`.
  '0080_retire_billing_proxy':
    'applied in production; ledger read 2026-11-05 held 0000–0082 before 0083 was authored',
  '0081_retire_billing_proxy_validate':
    'applied in production; ledger read 2026-11-05 held 0000–0082 before 0083 was authored',
  '0082_provider_events_drop_retry_after':
    'applied in production; ledger read 2026-11-05 held 0000–0082 before 0083 was authored',
  // The webhook endpoint `url_refused` validate half is applied in production:
  // a read-only ledger probe on 2026-11-05 counted 85 rows (`0000`–`0084`) and
  // the CHECK `convalidated` before ADR 0021's `0085`–`0088` were authored.
  '0084_webhook_endpoint_url_refused_validate':
    'applied in production; ledger read 2026-11-05 held 0000–0084 before 0085 was authored',
  // ADR 0021's validate half shipped with #237, whose deploy applied it: a
  // read-only ledger probe on 2026-11-06 counted 89 rows (`0000`–`0088`) before
  // the identity-wallet migrations `0089`–`0094` were authored.
  '0088_faircoin_offered_validate':
    'applied in production; ledger read 2026-11-06 held 0000–0088 before 0089 was authored',
};

interface Migration {
  readonly tag: string;
  readonly phase: string;
}

/** Every migration in journal order, with the phase its marker declares. */
function readMigrations(): Migration[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };

  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), 'utf8');
      const markers = [...sql.matchAll(/^--\s*oxy:deploy-phase=(\S+)\s*$/gm)].map(
        (match) => match[1] ?? '',
      );
      expect(markers, `${entry.tag} must declare exactly one deploy phase`).toHaveLength(1);
      return { tag: entry.tag, phase: markers[0] ?? '' };
    });
}

describe('migration deploy phases', () => {
  /**
   * There is no default: `bun run db:generate` writes the SQL and a human
   * chooses the phase, so a file with no marker is one nobody decided about.
   */
  test('every migration declares a phase, and it is pre or post', () => {
    const migrations = readMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    for (const { tag, phase } of migrations) {
      expect(['pre', 'post'], `${tag} declares an unknown phase '${phase}'`).toContain(phase);
    }
  });

  /**
   * THE gate. A `pre` after an unshipped `post` is a release that does not
   * deploy at all — the build goes green, the image is pushed, and the
   * migrator refuses before ECS is ever touched.
   */
  test('no pre migration is queued behind a post one', () => {
    const migrations = readMigrations();
    const blockers = migrations.filter(
      (migration) => migration.phase === 'post' && !(migration.tag in SHIPPED_BEFORE),
    );

    const stranded = migrations.flatMap((migration, index) => {
      if (migration.phase !== 'pre') return [];
      const blocker = blockers.find((candidate) => migrations.indexOf(candidate) < index);
      return blocker ? [`${migration.tag} is queued behind ${blocker.tag}`] : [];
    });

    expect(stranded).toEqual([]);
  });

  /**
   * The same rule said forwards, so the failure message names what to do
   * rather than what went wrong: if the new migration has to be `post`, it and
   * everything after it are `post` — the release's tail — and anything that
   * must run before the rollout has to land in an earlier release. Several
   * `post` files in a row are one post phase (a drop, then its validation,
   * then a hot table's DDL on its own).
   */
  test('unshipped post migrations are the tail of the journal', () => {
    const migrations = readMigrations();
    const first = migrations.findIndex(
      (migration) => migration.phase === 'post' && !(migration.tag in SHIPPED_BEFORE),
    );
    if (first === -1) return;
    for (const migration of migrations.slice(first)) {
      expect(migration.phase, `${migration.tag} follows an unshipped post migration`).toBe('post');
    }
  });
});
