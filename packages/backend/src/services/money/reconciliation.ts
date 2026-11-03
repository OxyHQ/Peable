/**
 * The daily reconciliation (ADR 0015 §4): the provider's balance transactions
 * and payouts for every account, compared with the ledger.
 *
 * It COMPARES and RECORDS. A difference becomes a `reconciliation_mismatches`
 * row (and a warning in the log, and a list in Orbit); the ledger is never
 * edited to make the difference go away. Only after the comparison does the run
 * perform the ordinary ingestion every event performs (`syncAccountLedger`) —
 * which is how a transaction a missed event left behind arrives — and the NEXT
 * run, finding the difference gone, closes the mismatch with when it was
 * resolved. Nothing is corrected silently: every gap stays on record.
 *
 * It also re-proves the one invariant no CHECK carries: every journal sums to
 * zero (`unbalanced_journal`).
 */
import {
  findCardAccounts,
  type CardConnectedAccountRow,
  type ConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import {
  findUnbalancedJournals,
  listProviderTransactionsSince,
} from '../../db/money/ledgerRepository';
import { listPayoutsSince } from '../../db/money/payoutRepository';
import { recordMismatch, resolveUnseenMismatches } from '../../db/money/reconciliationRepository';
import { getDb } from '../../db/postgres';
import { availableProviderModes } from '../providers/registry';
import type { ProviderBalanceTransaction, ProviderPayout } from '../providers/provider';
import { requireMirroringProvider, syncAccountLedger } from './ledger';
import { applyProviderPayout } from './payouts';

/** How far back each run compares. Older history was compared by earlier runs. */
export const RECONCILIATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AccountReconciliation {
  readonly account: string;
  readonly compared: number;
  readonly newMismatches: number;
  readonly resolved: number;
}

async function readAll<T extends { providerObjectId: string }>(
  read: (startingAfter?: string) => Promise<{ data: T[]; hasMore: boolean }>,
): Promise<T[]> {
  const out: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await read(startingAfter);
    out.push(...page.data);
    const last = page.data.at(-1);
    if (!page.hasMore || !last) return out;
    startingAfter = last.providerObjectId;
  }
}

/**
 * Compare one account over the window, record what differs, then ingest.
 * `now` is the run's start: open mismatches not seen again by it are resolved.
 */
export async function reconcileAccount(
  account: CardConnectedAccountRow,
  now: Date = new Date(),
): Promise<AccountReconciliation> {
  const provider = requireMirroringProvider(account.provider, account.livemode);
  const since = new Date(now.getTime() - RECONCILIATION_WINDOW_MS);
  const db = getDb();
  const scope = { merchantId: account.merchantId, connectedAccountId: account.id };
  let newMismatches = 0;
  const record = async (
    kind: Parameters<typeof recordMismatch>[1]['kind'],
    subject: string,
    objectPublicId: string | null,
    expected: Record<string, unknown> | null,
    actual: Record<string, unknown> | null,
  ) => {
    const fresh = await recordMismatch(db, {
      ...scope,
      kind,
      subject,
      objectPublicId,
      expected,
      actual,
      seenAt: now,
    });
    if (fresh) {
      newMismatches += 1;
      process.emitWarning(
        `Peable reconciliation: ${kind} on account ${account.publicId} (${objectPublicId ?? subject})`,
      );
    }
  };

  // Balance transactions, both ways.
  const theirs = await readAll<ProviderBalanceTransaction>((startingAfter) =>
    provider.listBalanceTransactions({
      account: account.providerAccountId,
      createdGte: since,
      limit: 100,
      ...(startingAfter !== undefined ? { startingAfter } : {}),
    }),
  );
  const ours = await listProviderTransactionsSince(db, scope, since);
  const oursByObject = new Map(ours.map((row) => [row.providerObjectId, row]));
  const theirIds = new Set(theirs.map((txn) => txn.providerObjectId));
  for (const txn of theirs) {
    const subject = `${account.provider}:${txn.providerObjectId}`;
    const row = oursByObject.get(txn.providerObjectId);
    const expected = {
      amount: txn.amount,
      fee: txn.fee,
      net: txn.net,
      currency: txn.currency,
      status: txn.status,
    };
    if (!row) {
      await record('missing_in_ledger', subject, null, expected, null);
      continue;
    }
    const actual = {
      amount: row.amount,
      fee: row.fee,
      net: row.net,
      currency: row.currency,
      status: row.status,
    };
    if (
      row.amount !== txn.amount ||
      row.fee !== txn.fee ||
      row.net !== txn.net ||
      row.currency !== txn.currency
    ) {
      await record('amount_mismatch', subject, row.publicId, expected, actual);
    } else if (row.status !== txn.status) {
      await record('status_mismatch', subject, row.publicId, expected, actual);
    }
  }
  for (const row of ours) {
    // Older than a day and still absent from the provider's own window.
    if (
      row.providerObjectId &&
      !theirIds.has(row.providerObjectId) &&
      row.occurredAt.getTime() < now.getTime() - DAY_MS
    ) {
      await record(
        'missing_at_provider',
        `${account.provider}:${row.providerObjectId}`,
        row.publicId,
        null,
        { amount: row.amount, currency: row.currency },
      );
    }
  }

  // Payouts.
  const theirPayouts = await readAll<ProviderPayout>((startingAfter) =>
    provider.listPayouts({
      account: account.providerAccountId,
      createdGte: since,
      limit: 100,
      ...(startingAfter !== undefined ? { startingAfter } : {}),
    }),
  );
  const ourPayouts = new Map(
    (await listPayoutsSince(db, account.id, since)).map((row) => [row.providerObjectId, row]),
  );
  for (const payout of theirPayouts) {
    const row = ourPayouts.get(payout.providerObjectId);
    const expected = { amount: payout.amount, currency: payout.currency, status: payout.status };
    if (!row || row.amount !== payout.amount || row.status !== payout.status) {
      await record(
        'payout_mismatch',
        `${account.provider}:${payout.providerObjectId}`,
        row?.publicId ?? null,
        expected,
        row ? { amount: row.amount, currency: row.currency, status: row.status } : null,
      );
    }
  }

  // The invariant.
  for (const journal of await findUnbalancedJournals(db, account.merchantId)) {
    await record(
      'unbalanced_journal',
      `journal:${journal.journalId}`,
      null,
      { sum: '0' },
      {
        sum: journal.sum,
      },
    );
  }

  const resolved = await resolveUnseenMismatches(db, scope, now);
  // Ordinary ingestion, AFTER the comparison: the gap is on record first.
  await syncAccountLedger(account, now);
  for (const payout of theirPayouts) await applyProviderPayout(account, payout);
  return {
    account: account.publicId,
    compared: theirs.length + theirPayouts.length,
    newMismatches,
    resolved,
  };
}

function asCard(row: ConnectedAccountRow): CardConnectedAccountRow | null {
  return row.provider && row.providerAccountId && row.country
    ? (row as CardConnectedAccountRow)
    : null;
}

/** One pass over every card account in the modes this deployment can read. */
export async function runMoneyReconciliation(
  now: Date = new Date(),
): Promise<AccountReconciliation[]> {
  const livemodes = availableProviderModes('stripe').map((mode) => mode === 'live');
  const results: AccountReconciliation[] = [];
  for (const row of await findCardAccounts(getDb(), livemodes)) {
    const account = asCard(row);
    if (!account) continue;
    try {
      results.push(await reconcileAccount(account, now));
    } catch (error) {
      // One account's provider failure must not stop the rest of the pass.
      process.emitWarning(
        `Peable reconciliation of ${account.publicId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return results;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the daily reconciliation. A second call is a no-op; the timer never holds the process. */
export function startMoneyReconciliation(options: { intervalMs?: number } = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runMoneyReconciliation().catch((error: unknown) => {
      process.emitWarning(
        `Peable reconciliation tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, options.intervalMs ?? DAY_MS);
  timer.unref?.();
}

export function stopMoneyReconciliation(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
