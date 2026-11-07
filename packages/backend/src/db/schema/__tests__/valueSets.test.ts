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
  WEBHOOK_ENABLED_EVENTS,
  INTENT_WEBHOOK_EVENT_TYPES,
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
  it("lists Stripe's event catalogue, and nothing of the pre-0019 vocabulary", () => {
    // 27 of ADR 0019 (the proxy's `billing.observation.updated` is gone) + the catalog's ten (ADR 0018) + the dispute funds pair
    // + Orbit money's nine (ADR 0015) + checkout's four and payment links'
    // two (Orbit Phase 3) + reporting's report run pair (Phase 8) + the billing
    // engine's 34 (ADR 0018) + business compliance's three (ADR 0020) + the
    // quotes' four (ADR 0018 §5).
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(97);
    for (const retired of [
      'billing.observation.updated',
      'payment_intent.settled',
      'payment_intent.confirming',
      'payment_intent.failed',
      'payment_intent.rejected',
      'payment_intent.expired',
      'payment_intent.refunded',
      'payment_intent.partially_refunded',
      'payment_intent.disputed',
      'payment_intent.dispute_closed',
    ]) {
      expect(WEBHOOK_EVENT_TYPES as readonly string[]).not.toContain(retired);
    }
  });

  /** The test event names its endpoint; it is never subscribed to. */
  it('lets an endpoint subscribe to every type but the targeted ones, and to *', () => {
    expect(WEBHOOK_ENABLED_EVENTS[0]).toBe('*');
    expect(WEBHOOK_ENABLED_EVENTS).not.toContain('webhook_endpoint.test');
    expect(WEBHOOK_ENABLED_EVENTS).toHaveLength(WEBHOOK_EVENT_TYPES.length);
  });

  /**
   * The split the delivery CHECK depends on — by DECLARED scope, not by name:
   * `charge.refunded`, `refund.*` and `charge.dispute.*` are named for another
   * object and are still about a payment, while `customer.*`,
   * `payment_method.*` and `setup_intent.*` name none.
   */
  it('splits into events about a payment and the ones that are not', () => {
    expect([...INTENT_WEBHOOK_EVENT_TYPES].sort() as string[]).toEqual(
      [
        'payment_intent.created',
        'payment_intent.requires_action',
        'payment_intent.processing',
        'payment_intent.amount_capturable_updated',
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'payment_intent.canceled',
        'charge.refunded',
        'charge.dispute.created',
        'charge.dispute.updated',
        'charge.dispute.closed',
        'charge.dispute.funds_withdrawn',
        'charge.dispute.funds_reinstated',
        'refund.created',
        'refund.updated',
        'refund.failed',
      ].sort(),
    );
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
        0,
      );
    // One per money-carrying COLUMN, which is not one per table:
    // payment_intents, checkout_sessions, payment_links, refunds, disputes and
    // transfer_reversals carry one `amount` each; `transfers` carries `amount`
    // AND the cumulative `amount_reversed`; `payment_intents.amount_received`,
    // and `charges` its `amount` and `amount_captured` (ADR 0019); the catalog's
    // `prices.unit_amount`, `coupons.amount_off` and
    // `promotion_codes.minimum_amount` (ADR 0018). A tiered price's tier amounts
    // live inside `prices.tiers` (jsonb) and are checked by its one writer.
    // Plus two RE-ADDED: `0049` re-adds the coupon and promotion-code CHECKs
    // (their currency set widened), and each carries the pattern again.
    // ADR 0015 adds `fee_schedules.fixed_amount`, `application_fees.amount`,
    // `application_fee_refunds.amount`, `payouts.amount` and the intent's
    // `application_fee_amount` and `transfer_amount` (the ledger's signed
    // amounts use their own pattern).
    // Orbit Phase 3: the four amounts of `checkout_session_line_items`, the
    // re-added `payment_links_amount_check` (now nullable) and the session's
    // four totals (`checkout_sessions_amounts_check`).
    // The billing engine's (ADR 0018) unsigned amounts: an invoice's
    // `amount_due`, `amount_paid` and its two credit-note totals; an invoice
    // item's `unit_amount`; a credit note's six totals and its lines' `amount`
    // and `tax_amount`; a meter event's `value`. (Its SIGNED amounts carry
    // `SIGNED_BASE_UNIT_STRING_PATTERN` instead.)
    // ADR 0021 D6: a FairCoin output's `amount` (`payment_intent_outputs`).
    // Quotes (ADR 0018 §5): a quote's four totals and its lines' four amounts.
    expect(occurrences).toBe(54);
  });
});
