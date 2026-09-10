/**
 * `connected_accounts` and `transfers`, against a real server.
 *
 * The arithmetic is the point. A reversal total is a canonical integer STRING,
 * and every comparison this schema makes about it — is it within the amount, is
 * it complete, is it going backwards — is wrong under text ordering in a way
 * that refuses legitimate refunds. None of that is visible to a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { isCheckViolation, uuidv7 } from '@oxy.so/db';
import {
  applyAccountSnapshot,
  findAccountByExternalRef,
  findAccountByProviderAccountId,
  findAccountByPublicId,
  findAccountsToSync,
  insertConnectedAccount,
  type AccountSnapshot,
} from '../accounts/connectedAccountRepository';
import {
  TransferReversalTooLargeError,
  applyTransferReversal,
  findTransferByExternalRef,
  insertTransfer,
  listTransfersForIntent,
  markTransferFailed,
  markTransferPaid,
} from '../transfers/transferRepository';
import { insertMerchant, type MerchantRow } from '../merchants/merchantRepository';
import { insertPaymentIntent } from '../payments/paymentIntentRepository';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  dropSuiteDatabase,
  type SuiteDatabase,
} from '../testDatabase';
import { testXpubFor } from '../../__tests__/helpers/gatewayTestDatabase';

let suite: SuiteDatabase | undefined;
let merchant: MerchantRow;
let intentId: string;

const EMPTY_SNAPSHOT: AccountSnapshot = {
  payoutsEnabled: false,
  chargesEnabled: false,
  transfersCapability: null,
  cardPaymentsCapability: null,
  currentlyDue: [],
  eventuallyDue: [],
  pastDue: [],
  pendingVerification: [],
  disabledReasonCodes: [],
  defaultCurrency: null,
};

async function seedAccount(externalRef: string) {
  const unique = uuidv7();
  const row = await insertConnectedAccount(suite!.db, {
    publicId: `ca_${unique}`,
    merchantId: merchant.id,
    externalRef,
    provider: 'stripe',
    providerAccountId: `acct_${unique}`,
    country: 'ES',
  });
  if (!row) throw new Error(`seedAccount: ${externalRef} already exists`);
  return row;
}

async function seedTransfer(accountId: string, externalRef: string, amount: string) {
  const row = await insertTransfer(suite!.db, {
    publicId: `tr_${uuidv7()}`,
    merchantId: merchant.id,
    paymentIntentId: intentId,
    connectedAccountId: accountId,
    externalRef,
    amount,
    currency: 'EUR',
    provider: 'stripe',
    sourcePaymentObjectId: 'ch_1',
  });
  if (!row) throw new Error(`seedTransfer: ${externalRef} already exists`);
  return row;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('connected accounts and transfers', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
    const seeded = await insertMerchant(suite.db, {
      publicId: `merch_${uuidv7()}`,
      oxyAppId: `app_${uuidv7()}`,
      environment: 'development',
      network: 'testnet',
      xpub: testXpubFor('testnet'),
    });
    if (!seeded) throw new Error('could not seed the merchant');
    merchant = seeded;

    const intent = await insertPaymentIntent(suite.db, {
      publicId: `pi_${uuidv7()}`,
      merchantId: merchant.id,
      rail: 'card',
      amount: '100000',
      currency: 'EUR',
      network: null,
      address: null,
      provider: 'stripe',
      clientSecret: 'cs_x',
      idempotencyKey: uuidv7(),
      metadata: {},
      expiresAt: new Date(Date.now() + 900_000),
    });
    if (!intent) throw new Error('could not seed the intent');
    intentId = intent.id;
  });

  afterAll(async () => {
    await dropSuiteDatabase(suite);
    suite = undefined;
  });

  // ── connected accounts ───────────────────────────────────────────────────

  /**
   * The convergence that stops a race opening TWO real accounts at the
   * provider. That is not an error that can be undone — an account cannot be
   * deleted, and the seller is left with one nobody uses.
   */
  it('converges when the same seller is onboarded twice', async () => {
    const first = await seedAccount('store_dup');
    const second = await insertConnectedAccount(suite!.db, {
      publicId: `ca_${uuidv7()}`,
      merchantId: merchant.id,
      externalRef: 'store_dup',
      provider: 'stripe',
      providerAccountId: `acct_${uuidv7()}`,
      country: 'ES',
    });

    expect(second).toBeNull();
    const found = await findAccountByExternalRef(suite!.db, merchant.id, 'store_dup');
    expect(found?.id).toBe(first.id);
  });

  it('lets exactly one of two concurrent onboardings win', async () => {
    const attempt = () =>
      insertConnectedAccount(suite!.db, {
        publicId: `ca_${uuidv7()}`,
        merchantId: merchant.id,
        externalRef: 'store_race',
        provider: 'stripe',
        providerAccountId: `acct_${uuidv7()}`,
        country: 'ES',
      });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(results.filter((row) => row !== null)).toHaveLength(1);
  });

  /**
   * A snapshot is an OVERWRITE, not a merge. A requirement that has been
   * satisfied simply disappears from the provider's response, and merging would
   * leave it standing forever — a seller told to do something they already did,
   * with no way to clear it.
   */
  it('clears a requirement that the provider no longer reports', async () => {
    const account = await seedAccount('store_snapshot');

    await applyAccountSnapshot(suite!.db, account.id, {
      ...EMPTY_SNAPSHOT,
      currentlyDue: ['business_profile.url', 'individual.id_number'],
      disabledReasonCodes: ['requirements.past_due'],
      transfersCapability: 'pending',
    });
    let after = await findAccountByExternalRef(suite!.db, merchant.id, 'store_snapshot');
    expect(after?.requirementsCurrentlyDue).toBe(2);
    expect(after?.disabledReasonCodes).toEqual(['requirements.past_due']);

    // The seller does the work; the provider stops reporting any of it.
    await applyAccountSnapshot(suite!.db, account.id, {
      ...EMPTY_SNAPSHOT,
      payoutsEnabled: true,
      transfersCapability: 'active',
      defaultCurrency: 'EUR',
    });
    after = await findAccountByExternalRef(suite!.db, merchant.id, 'store_snapshot');
    expect(after?.requirementsCurrentlyDue).toBe(0);
    expect(after?.disabledReasonCodes).toEqual([]);
    expect(after?.payoutsEnabled).toBe(true);
    expect(after?.lastSyncedAt).toBeInstanceOf(Date);
  });

  /**
   * A blank code renders as an empty bullet in a seller's dashboard, and the
   * CHECK refuses it. Dropping it in the repository means one odd code from a
   * provider does not fail the whole sync — the row is more useful with the
   * rest than refused for one blank.
   */
  it('drops a blank disabled-reason code rather than failing the sync', async () => {
    const account = await seedAccount('store_blank_code');
    const row = await applyAccountSnapshot(suite!.db, account.id, {
      ...EMPTY_SNAPSHOT,
      disabledReasonCodes: ['under_review', '', 'requirements.past_due'],
    });
    expect(row?.disabledReasonCodes).toEqual(['under_review', 'requirements.past_due']);
  });

  it('refuses a capability value no provider reports', async () => {
    const account = await seedAccount('store_bad_capability');
    let raised: unknown;
    try {
      await applyAccountSnapshot(suite!.db, account.id, {
        ...EMPTY_SNAPSHOT,
        transfersCapability: 'unrequested' as never,
      });
    } catch (error) {
      raised = error;
    }
    expect(isCheckViolation(raised, 'connected_accounts_transfers_capability_check')).toBe(true);
  });

  it('finds an account by the merchant address and by the provider address', async () => {
    const account = await seedAccount('store_lookup');
    expect((await findAccountByPublicId(suite!.db, merchant.id, account.publicId))?.id).toBe(
      account.id
    );
    expect(
      (await findAccountByProviderAccountId(suite!.db, 'stripe', account.providerAccountId))?.id
    ).toBe(account.id);
    // ...and NOT for a different merchant, which is the access control.
    expect(await findAccountByPublicId(suite!.db, 'someone-else', account.publicId)).toBeNull();
  });

  /**
   * `NULLS FIRST`, and it is load-bearing. PostgreSQL's default for `ASC` is
   * `NULLS LAST`, which would put the accounts nothing is known about at the
   * very BACK of the sync queue, behind every account already known to be fine.
   */
  it('syncs never-synced accounts before ones it has already read', async () => {
    const stale = await seedAccount('store_stale');
    const never = await seedAccount('store_never');
    await applyAccountSnapshot(suite!.db, stale.id, EMPTY_SNAPSHOT, new Date(Date.now() - 86_400_000));

    const queue = await findAccountsToSync(suite!.db, 'stripe', 100);
    const ids = queue.map((row) => row.id);
    expect(ids.indexOf(never.id)).toBeLessThan(ids.indexOf(stale.id));
  });

  // ── transfers ────────────────────────────────────────────────────────────

  it('converges when the same order is settled twice', async () => {
    const account = await seedAccount('store_t1');
    const first = await seedTransfer(account.id, 'order_dup', '5000');
    const second = await insertTransfer(suite!.db, {
      publicId: `tr_${uuidv7()}`,
      merchantId: merchant.id,
      paymentIntentId: intentId,
      connectedAccountId: account.id,
      externalRef: 'order_dup',
      amount: '5000',
      currency: 'EUR',
      provider: 'stripe',
      sourcePaymentObjectId: 'ch_1',
    });

    expect(second).toBeNull();
    expect((await findTransferByExternalRef(suite!.db, merchant.id, 'order_dup'))?.id).toBe(
      first.id
    );
  });

  it('links the provider object once and refuses to repoint it', async () => {
    const account = await seedAccount('store_t2');
    const transfer = await seedTransfer(account.id, 'order_link', '5000');

    expect((await markTransferPaid(suite!.db, transfer.id, 'tr_stripe_1'))?.status).toBe('paid');
    // A second provider object for this transfer means the seller was paid
    // twice; moving the row would hide the first payment rather than surface it.
    expect(await markTransferPaid(suite!.db, transfer.id, 'tr_stripe_2')).toBeNull();
  });

  /**
   * THE case the `::numeric` cast exists for. `'9' <= '10'` is FALSE as text —
   * measured on the server — so a text comparison refuses a legitimate reversal
   * of 9 against an amount of 10, and a seller's refund silently fails.
   */
  it('accepts a reversal that a text comparison would refuse', async () => {
    const account = await seedAccount('store_t3');
    const transfer = await seedTransfer(account.id, 'order_lexical', '10');
    await markTransferPaid(suite!.db, transfer.id, 'tr_stripe_lex');

    const row = await applyTransferReversal(suite!.db, transfer.id, '9');
    expect(row?.amountReversed).toBe('9');
    expect(row?.status).toBe('partially_reversed');
  });

  /**
   * More cannot come back than went out, and the error has to SAY that.
   *
   * Left to the database this refusal arrives named
   * `transfers_reversal_status_agrees_check` — measured — because the `>=` in
   * the status CASE turns an over-total into `'reversed'` before the amount
   * check is reached, and a reader chasing that name looks at the wrong thing.
   */
  it('refuses a reversal larger than the transfer, and names the reason', async () => {
    const account = await seedAccount('store_t4');
    const transfer = await seedTransfer(account.id, 'order_over', '100');
    await markTransferPaid(suite!.db, transfer.id, 'tr_stripe_over');

    await expect(applyTransferReversal(suite!.db, transfer.id, '101')).rejects.toThrow(
      TransferReversalTooLargeError
    );

    const untouched = await findTransferByExternalRef(suite!.db, merchant.id, 'order_over');
    expect(untouched?.amountReversed).toBe('0');
    expect(untouched?.status).toBe('paid');
  });

  /**
   * `BigInt`, not `Number`. These columns hold unbounded canonical integer
   * strings, so an amount beyond `Number.MAX_SAFE_INTEGER` is expressible — and
   * a float comparison starts rounding exactly there, letting a reversal one
   * unit too large through on the largest transfers.
   */
  it('compares totals beyond the safe-integer range without rounding', async () => {
    const account = await seedAccount('store_t4_big');
    // These two values are chosen, not decorative: `Number` rounds
    // `…993` down to `…992`, so a float comparison says the over-total is NOT
    // larger and lets it through. `BigInt` says it is. Verified in isolation
    // before this test was written — an earlier pair (…993 / …994) rounded to
    // DIFFERENT floats and the test passed against both implementations,
    // proving nothing.
    const amount = '9007199254740992'; // MAX_SAFE_INTEGER + 1
    const over = '9007199254740993';
    const transfer = await seedTransfer(account.id, 'order_big', amount);
    await markTransferPaid(suite!.db, transfer.id, 'tr_stripe_big');

    await expect(applyTransferReversal(suite!.db, transfer.id, over)).rejects.toThrow(
      TransferReversalTooLargeError
    );

    // ...and the exact amount is still accepted.
    const full = await applyTransferReversal(suite!.db, transfer.id, amount);
    expect(full?.status).toBe('reversed');
  });

  /**
   * The total is CUMULATIVE and the status is derived from it in the same
   * statement. A second partial reversal that reported only its own leg would
   * walk the total backwards, and the constraint would refuse the result rather
   * than store a seller balance that disagrees with the row explaining it.
   */
  it('follows a transfer through two partial reversals to full', async () => {
    const account = await seedAccount('store_t5');
    const transfer = await seedTransfer(account.id, 'order_partial', '100');
    await markTransferPaid(suite!.db, transfer.id, 'tr_stripe_partial');

    expect((await applyTransferReversal(suite!.db, transfer.id, '30'))?.status).toBe(
      'partially_reversed'
    );
    expect((await applyTransferReversal(suite!.db, transfer.id, '70'))?.status).toBe(
      'partially_reversed'
    );
    const full = await applyTransferReversal(suite!.db, transfer.id, '100');
    expect(full?.status).toBe('reversed');
    expect(full?.amountReversed).toBe('100');
  });

  /**
   * A provider event arriving out of order must not walk a reversal backwards.
   * Stripe redelivers, and it does not promise order — a late first leg landing
   * after the second would otherwise un-reverse a transfer.
   */
  it('ignores a reversal total smaller than the one already recorded', async () => {
    const account = await seedAccount('store_t6');
    const transfer = await seedTransfer(account.id, 'order_ooo', '100');
    await markTransferPaid(suite!.db, transfer.id, 'tr_stripe_ooo');
    await applyTransferReversal(suite!.db, transfer.id, '100');

    // The late delivery of the first leg.
    expect(await applyTransferReversal(suite!.db, transfer.id, '40')).toBeNull();
    const still = await findTransferByExternalRef(suite!.db, merchant.id, 'order_ooo');
    expect(still?.status).toBe('reversed');
    expect(still?.amountReversed).toBe('100');
  });

  it('records a provider refusal without a provider object', async () => {
    const account = await seedAccount('store_t7');
    const transfer = await seedTransfer(account.id, 'order_failed', '5000');
    const failed = await markTransferFailed(suite!.db, transfer.id, 'insufficient funds');
    expect(failed?.status).toBe('failed');
    expect(failed?.providerObjectId).toBeNull();
  });

  it('lists every transfer a payment funded', async () => {
    const account = await seedAccount('store_t8');
    await seedTransfer(account.id, 'order_list_a', '1000');
    await seedTransfer(account.id, 'order_list_b', '2000');

    const rows = await listTransfersForIntent(suite!.db, intentId);
    const refs = rows.map((row) => row.externalRef);
    expect(refs).toContain('order_list_a');
    expect(refs).toContain('order_list_b');
  });
});
