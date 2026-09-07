import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAYMENT_INTENT_STATUSES, isBaseUnitString } from '@peable.to/shared-types';
import {
  BASE_UNIT_STRING_PATTERN,
  NETWORK_TYPES,
  PAYMENT_INTENT_STATUS_VALUES,
  PROVIDER_IDS,
  WEBHOOK_EVENT_TYPES,
} from '../valueSets';

/**
 * The tuples that render this schema's CHECK constraints, held against the
 * runtime sources of truth they mirror.
 *
 * The type-level `AssertAllListed` aliases in `valueSets.ts` already refuse a
 * union member no tuple lists. What they cannot see is a runtime array
 * (`PAYMENT_INTENT_STATUSES`, derived from `Object.keys`) or a regular
 * expression in another package — both of which decide what the database
 * accepts and neither of which `tsc` compares against anything.
 */

describe('closed value sets', () => {
  it('lists exactly the statuses the shared transition table defines', () => {
    expect([...PAYMENT_INTENT_STATUS_VALUES].sort()).toEqual([...PAYMENT_INTENT_STATUSES].sort());
  });

  /**
   * The runtime half of the provider pin.
   *
   * `ProvidersAreComplete` in `valueSets.ts` already makes a `ProviderId` this
   * tuple does not list a compile error. What no type can see is whether the
   * tuple actually reached the database: the CHECK is rendered from it once, at
   * generation time, and a regeneration that dropped it would leave a column
   * that accepts any string with every test still green.
   */
  it('renders the provider CHECK into the migrations from this tuple', () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
    const sqlText = readdirSync(migrationsDir)
      .filter((entry) => entry.endsWith('.sql'))
      .map((file) => readFileSync(join(migrationsDir, file), 'utf8'))
      .join('\n');

    const rendered = PROVIDER_IDS.map((id) => `'${id}'`).join(', ');
    expect(sqlText).toContain(`provider in (${rendered})`);
  });

  it('lists both networks', () => {
    expect([...NETWORK_TYPES].sort()).toEqual(['mainnet', 'testnet']);
  });

  /**
   * A COUNT rather than a list, so widening the contract is a deliberate edit
   * here. The `satisfies` on the tuple already proves every member is a legal
   * `WebhookEventType`; what no type can see is a member being ADDED without
   * anyone noticing that merchants now receive an event they never subscribed
   * to.
   */
  it('lists the nine webhook event types', () => {
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(9);
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(type.startsWith('payment_intent.')).toBe(true);
    }
  });
});

describe('the base-unit amount pattern', () => {
  /**
   * The CHECK and `isBaseUnitString` must agree, or a value the application
   * accepts is refused by the database (or, worse, the reverse). Compared by
   * BEHAVIOUR over the cases that distinguish them rather than by reading the
   * regex source out of the other package, which would pass for any two
   * patterns spelled the same and fail for any two spelled differently while
   * meaning the same thing.
   */
  const cases: readonly { value: string; valid: boolean }[] = [
    { value: '0', valid: true },
    { value: '1', valid: true },
    { value: '100000000', valid: true },
    { value: '90071992547409910', valid: true },
    // Leading zero: two spellings of one amount is one spelling too many.
    { value: '01', valid: false },
    { value: '00', valid: false },
    { value: '1.5', valid: false },
    { value: '-1', valid: false },
    { value: '+1', valid: false },
    { value: '1e8', valid: false },
    { value: '', valid: false },
    { value: ' 1', valid: false },
    { value: '1 ', valid: false },
  ];

  it('accepts and refuses exactly what the application does', () => {
    const pattern = new RegExp(BASE_UNIT_STRING_PATTERN);
    for (const { value, valid } of cases) {
      expect([value, pattern.test(value)]).toEqual([value, valid]);
      expect([value, isBaseUnitString(value)]).toEqual([value, valid]);
    }
  });

  /**
   * The pattern reaches the database as a SQL literal inside a CHECK, so a
   * character SQL treats specially would change what the constraint means.
   * Asserted against the generated migration rather than the TypeScript,
   * because that file is what Postgres parses.
   */
  it('reaches the migrations verbatim', () => {
    // The whole directory, never a hard-coded file name: drizzle-kit picks the
    // suffix at random, so naming one file makes this test a rename away from
    // reading nothing and passing.
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
    const files = readdirSync(migrationsDir).filter((entry) => entry.endsWith('.sql'));
    expect(files.length).toBeGreaterThanOrEqual(1);

    // Searched WITHOUT the column name. It used to look for `amount ~ '…'`,
    // which silently skipped `transfers.amount_reversed` — a column in the same
    // canonical-integer domain, guarded by the same pattern, and invisible to a
    // search anchored on `amount`. A test that cannot see a guarded column
    // cannot notice the day that column stops being guarded.
    const occurrences = files
      .map((file) => readFileSync(join(migrationsDir, file), 'utf8'))
      .reduce(
        (total, contents) => total + contents.split(`~ '${BASE_UNIT_STRING_PATTERN}'`).length - 1,
        0
      );
    // One per money-carrying COLUMN, which is not one per table:
    // payment_intents, checkout_sessions, payment_links, refunds and disputes
    // carry one `amount` each; `transfers` carries `amount` AND the cumulative
    // `amount_reversed`.
    expect(occurrences).toBe(7);
  });
});
