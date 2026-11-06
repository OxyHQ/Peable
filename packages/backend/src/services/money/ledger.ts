/**
 * The ledger (ADR 0015 §4): ingesting the provider's balance transactions,
 * posting their double entries, and reading a balance back.
 *
 * ## Never invented
 *
 * Every provider row is the provider's own transaction, its amount, fee and net
 * copied verbatim; nothing here computes a figure the provider did not give.
 * Ingestion is idempotent on the provider transaction id, so reading a page
 * twice, or two readers racing over it, posts each transaction once.
 *
 * ## The postings
 *
 * - first seen (`recognized`): `+net` to the transaction's status (`pending` or
 *   `available`), `-net` to `external`;
 * - funds released later (`released`): `-net` pending, `+net` available;
 * - a FairCoin payment (§5): `+amount` informational, `-amount` external — and
 *   a chain reorg posts the reversal, so the informational sum follows the
 *   payment's status.
 *
 * Every journal sums to zero (`postJournal` refuses one that does not).
 *
 * ## Whose ledger
 *
 * A merchant's own account and a marketplace seller's account are read from
 * that provider account (`Stripe-Account`). An Oxy first-party merchant has no
 * account: its platform charges are on the platform's own balance, so each of
 * its charges' transactions is read individually and attributed to it
 * (`connected_account_id` NULL). The platform's payouts are the operator's
 * treasury and belong to no merchant, so a first-party ledger has none.
 */
import type { BalanceTransactionType } from '@peable.to/shared-types';
import {
  advanceBalanceCursor,
  findAccountForOnboarding,
  type CardConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import { findFeeByProviderObject } from '../../db/money/applicationFeeRepository';
import {
  attachBalanceTransactionPayout,
  findBalanceTransactionByIngestionKey,
  findOldestPendingTransaction,
  insertBalanceTransaction,
  listFaircoinEntriesForIntent,
  postJournal,
  readLedgerBalance,
  releaseBalanceTransaction,
  type BalanceTransactionRow,
  type LedgerScope,
} from '../../db/money/ledgerRepository';
import { findPayoutByProviderObject } from '../../db/money/payoutRepository';
import { recordMismatch } from '../../db/money/reconciliationRepository';
import {
  faircoinOutputsOf,
  findIntentByProviderCharge,
  type PaymentIntentRow,
} from '../../db/payments/paymentIntentRepository';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { findRefundByProviderObject } from '../../db/refunds/refundRepository';
import { findTransferByProviderObject } from '../../db/transfers/transferRepository';
import { findDisputeByProviderObject } from '../../db/disputes/disputeRepository';
import { newId } from '../../lib/ids';
import { selectStoredProvider } from '../providers/environmentGuard';
import {
  isMoneyMirroringProvider,
  type MoneyMirroringProvider,
  type ProviderBalanceTransaction,
  type ProviderId,
} from '../providers/provider';

/** The provider cannot mirror balances in this mode. 503. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerUnavailableError';
  }
}

/** The adapter that reads an account's (or a stored payment's) balance, in its own mode. */
export function requireMirroringProvider(
  provider: ProviderId,
  livemode: boolean,
): MoneyMirroringProvider {
  const adapter = selectStoredProvider(provider, livemode);
  if (!adapter) {
    throw new LedgerUnavailableError(
      `the ${provider} rail is not configured for ${livemode ? 'live' : 'test'} mode on this deployment`,
    );
  }
  if (!isMoneyMirroringProvider(adapter)) {
    throw new LedgerUnavailableError(`the ${provider} rail cannot report balances`);
  }
  return adapter;
}

export interface IngestContext extends LedgerScope {
  readonly provider: ProviderId;
  /** The payout these transactions belong to, when read with a `payout=` filter. */
  readonly payoutId?: string;
}

export interface IngestOutcome {
  readonly created: number;
  readonly released: number;
  readonly mismatched: number;
}

/** The Orbit object a provider source names, by public id — scoped to the merchant. */
async function resolveSource(
  db: DatabaseOrTransaction,
  ctx: IngestContext,
  txn: ProviderBalanceTransaction,
): Promise<{ sourceType: string | null; sourceId: string | null; paymentIntentId: string | null }> {
  const none = { sourceType: null, sourceId: null, paymentIntentId: null };
  const id = txn.sourceObjectId;
  if (id === null) return none;
  const mine = <T extends { merchantId: string }>(row: T | null): T | null =>
    row && row.merchantId === ctx.merchantId ? row : null;
  switch (txn.sourceKind) {
    case 'charge': {
      const intent = mine(
        await findIntentByProviderCharge(db, ctx.provider, txn.originatingChargeObjectId ?? id),
      );
      if (!intent) return none;
      return intent.latestChargePublicId
        ? {
            sourceType: 'charge',
            sourceId: intent.latestChargePublicId,
            paymentIntentId: intent.id,
          }
        : { sourceType: 'payment_intent', sourceId: intent.publicId, paymentIntentId: intent.id };
    }
    case 'refund': {
      const refund = mine(await findRefundByProviderObject(db, ctx.provider, id));
      return refund
        ? {
            sourceType: 'refund',
            sourceId: refund.publicId,
            paymentIntentId: refund.paymentIntentId,
          }
        : none;
    }
    case 'payout': {
      const payout = mine(await findPayoutByProviderObject(db, ctx.provider, id));
      return payout
        ? { sourceType: 'payout', sourceId: payout.publicId, paymentIntentId: null }
        : none;
    }
    case 'application_fee': {
      const fee = mine(await findFeeByProviderObject(db, ctx.provider, id));
      return fee
        ? {
            sourceType: 'application_fee',
            sourceId: fee.publicId,
            paymentIntentId: fee.paymentIntentId,
          }
        : none;
    }
    case 'transfer': {
      const transfer = mine(await findTransferByProviderObject(db, ctx.provider, id));
      return transfer
        ? { sourceType: 'transfer', sourceId: transfer.publicId, paymentIntentId: null }
        : none;
    }
    case 'dispute': {
      const dispute = mine(await findDisputeByProviderObject(db, ctx.provider, id));
      return dispute
        ? { sourceType: 'dispute', sourceId: dispute.publicId, paymentIntentId: null }
        : none;
    }
    default:
      return none;
  }
}

/** The figures a provider transaction is identified by — what may never change. */
function figuresOf(row: Pick<BalanceTransactionRow, 'amount' | 'fee' | 'net' | 'currency'>) {
  return { amount: row.amount, fee: row.fee, net: row.net, currency: row.currency };
}

function sameFigures(stored: BalanceTransactionRow, txn: ProviderBalanceTransaction): boolean {
  return (
    stored.amount === txn.amount &&
    stored.fee === txn.fee &&
    stored.net === txn.net &&
    stored.currency === txn.currency
  );
}

/**
 * Ingest one provider transaction, in its own database transaction: record it
 * and post `recognized`, or — already recorded — post `released` when the
 * provider has made it available since. A recorded transaction whose figures
 * DIFFER is not overwritten: the difference is recorded as a mismatch, because
 * a provider balance transaction does not change and one that appears to has
 * to be looked at by a person.
 */
async function ingestOne(
  ctx: IngestContext,
  txn: ProviderBalanceTransaction,
): Promise<'created' | 'released' | 'mismatched' | 'unchanged'> {
  const ingestionKey = `${ctx.provider}:${txn.providerObjectId}`;
  return getDb().transaction(async (tx) => {
    const existing = await findBalanceTransactionByIngestionKey(tx, ingestionKey);
    if (existing) {
      if (existing.merchantId !== ctx.merchantId || !sameFigures(existing, txn)) {
        await recordMismatch(tx, {
          merchantId: existing.merchantId,
          connectedAccountId: existing.connectedAccountId,
          kind: 'amount_mismatch',
          subject: ingestionKey,
          objectPublicId: existing.publicId,
          expected: figuresOf(txn),
          actual: figuresOf(existing),
          seenAt: new Date(),
        });
        return 'mismatched';
      }
      if (ctx.payoutId !== undefined && existing.payoutId === null) {
        await attachBalanceTransactionPayout(tx, existing.id, ctx.payoutId);
      }
      if (existing.status === 'pending' && txn.status === 'available') {
        const released = await releaseBalanceTransaction(tx, existing.id, txn.availableOn);
        if (released && released.net !== null) {
          const net = BigInt(released.net);
          await postJournal(tx, released, 'released', [
            { balanceType: 'pending', amount: -net },
            { balanceType: 'available', amount: net },
          ]);
          return 'released';
        }
      }
      return 'unchanged';
    }
    const source = await resolveSource(tx, ctx, txn);
    const inserted = await insertBalanceTransaction(tx, {
      publicId: newId('txn'),
      merchantId: ctx.merchantId,
      connectedAccountId: ctx.connectedAccountId,
      ingestionKey,
      provider: ctx.provider,
      providerObjectId: txn.providerObjectId,
      amount: txn.amount,
      fee: txn.fee,
      net: txn.net,
      currency: txn.currency,
      type: txn.type,
      reportingCategory: txn.reportingCategory,
      status: txn.status,
      availableOn: txn.availableOn,
      occurredAt: txn.created,
      description: txn.description,
      exchangeRate: txn.exchangeRate,
      feeDetails: txn.feeDetails,
      ...source,
      payoutId: ctx.payoutId ?? null,
    });
    // A concurrent reader recorded it between the read and the insert; its
    // journal is its own.
    if (!inserted) return 'unchanged';
    const net = BigInt(txn.net);
    await postJournal(tx, inserted, 'recognized', [
      { balanceType: txn.status, amount: net },
      { balanceType: 'external', amount: -net },
    ]);
    return 'created';
  });
}

/** Ingest a page of provider transactions. Each is its own database transaction. */
export async function ingestProviderTransactions(
  ctx: IngestContext,
  txns: readonly ProviderBalanceTransaction[],
): Promise<IngestOutcome> {
  let created = 0;
  let released = 0;
  let mismatched = 0;
  for (const txn of txns) {
    const outcome = await ingestOne(ctx, txn);
    if (outcome === 'created') created += 1;
    else if (outcome === 'released') released += 1;
    else if (outcome === 'mismatched') mismatched += 1;
  }
  return { created, released, mismatched };
}

/** How far back a sync re-reads before its cursor: late-visible transactions are still found. */
const SYNC_OVERLAP_MS = 24 * 60 * 60 * 1000;
/** The furthest back a sync ever reads; older history is the reconciliation's to report. */
const SYNC_MAX_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

/**
 * Bring one account's ledger up to date with the provider: every transaction
 * created since the cursor (less an overlap), and — so a release is seen — since
 * the oldest one still pending. Called from the account's provider events, the
 * daily job, and the first read of a balance that has never been synced.
 */
export async function syncAccountLedger(
  account: CardConnectedAccountRow,
  now: Date = new Date(),
): Promise<IngestOutcome> {
  const provider = requireMirroringProvider(account.provider, account.livemode);
  const floor = new Date(now.getTime() - SYNC_MAX_LOOKBACK_MS);
  const cursor = account.balanceSyncedThrough
    ? new Date(account.balanceSyncedThrough.getTime() - SYNC_OVERLAP_MS)
    : floor;
  const oldestPending = await findOldestPendingTransaction(getDb(), account.id);
  let from = oldestPending && oldestPending < cursor ? oldestPending : cursor;
  if (from < floor) from = floor;

  const ctx: IngestContext = {
    merchantId: account.merchantId,
    connectedAccountId: account.id,
    provider: account.provider,
  };
  const total = { created: 0, released: 0, mismatched: 0 };
  let newest: Date | null = null;
  let startingAfter: string | undefined;
  for (;;) {
    const page = await provider.listBalanceTransactions({
      account: account.providerAccountId,
      createdGte: from,
      limit: PAGE_SIZE,
      ...(startingAfter !== undefined ? { startingAfter } : {}),
    });
    const outcome = await ingestProviderTransactions(ctx, page.data);
    total.created += outcome.created;
    total.released += outcome.released;
    total.mismatched += outcome.mismatched;
    for (const txn of page.data) if (!newest || txn.created > newest) newest = txn.created;
    const last = page.data.at(-1);
    if (!page.hasMore || !last) break;
    startingAfter = last.providerObjectId;
  }
  await advanceBalanceCursor(getDb(), account.id, newest ?? from);
  return total;
}

/**
 * A first-party merchant's platform charge (§ "Whose ledger"): the charge's own
 * balance transaction and its refunds', read from the platform account and
 * attributed to the merchant. Best-effort and re-runnable — idempotent like
 * every ingestion — so the event drain calls it after a charge or refund moved.
 */
export async function syncPlatformChargeLedger(intent: PaymentIntentRow): Promise<IngestOutcome> {
  if (intent.rail !== 'card' || !intent.provider || !intent.providerChargeId) {
    return { created: 0, released: 0, mismatched: 0 };
  }
  const provider = requireMirroringProvider(intent.provider, intent.livemode);
  const txns = await provider.getChargeBalanceTransactions(intent.providerChargeId);
  return ingestProviderTransactions(
    { merchantId: intent.merchantId, connectedAccountId: null, provider: intent.provider },
    txns,
  );
}

/**
 * After a card payment or refund moved: bring the ledger it belongs to up to
 * date. A destination charge's money is on the destination account; a
 * first-party merchant's on the platform. A marketplace's platform charge is on
 * NO merchant's ledger (ADR 0015: the platform's balance is not a merchant's),
 * so nothing is read. Never throws: the mirror catches up on the next event or
 * the daily job.
 */
export async function syncLedgerAfterPayment(
  intent: PaymentIntentRow,
  firstParty: boolean,
): Promise<void> {
  try {
    if (intent.transferDestinationId) {
      const account = await findAccountForOnboarding(getDb(), intent.transferDestinationId);
      if (account?.provider && account.providerAccountId && account.country) {
        await syncAccountLedger(account as CardConnectedAccountRow);
      }
      return;
    }
    if (firstParty) await syncPlatformChargeLedger(intent);
  } catch (error) {
    process.emitWarning(
      `Peable ledger sync after ${intent.publicId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The FairCoin side (ADR 0015 §5), in the TRANSITION's transaction: a payment
 * reaching `succeeded` posts an informational entry for its full amount, and a
 * reorg that rewinds it posts the reversal — so the informational balance is
 * always the sum of the merchant's succeeded FairCoin payments. The coins are
 * in the payee's own wallet; nothing here is ever payable.
 *
 * On-behalf payments (ADR 0012) are the SELLER's coins: recorded against the
 * seller's account. A quoted payment (a fiat order, ADR 0021) carries its quote,
 * so the books show the fiat equivalent it was priced at.
 */
export async function recordFaircoinLedger(
  tx: DatabaseOrTransaction,
  intent: PaymentIntentRow,
  from: PaymentIntentRow['status'],
): Promise<void> {
  if (intent.rail !== 'faircoin') return;
  const reached = intent.status === 'succeeded' && from !== 'succeeded';
  const rewound = from === 'succeeded' && intent.status !== 'succeeded';
  if (!reached && !rewound) return;
  const entries = await listFaircoinEntriesForIntent(tx, intent.id);
  // One entry per OUTPUT (ADR 0021 D6), against the account it paid: a
  // multi-seller payment is each seller's coins, never the merchant's.
  for (const output of faircoinOutputsOf(intent)) {
    const own = entries.filter(
      (row) => (row.connectedAccountId ?? null) === output.connectedAccountId,
    );
    // Payments are positive and reversals negative: the sum is what is recorded now.
    const net = own.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    // Idempotent by the running sum, not by a flag: posting only when the sum
    // says the output is not yet (or no longer) recorded.
    if (reached && net !== 0n) continue;
    if (rewound && net === 0n) continue;
    const type: BalanceTransactionType = reached ? 'faircoin_payment' : 'faircoin_payment_reversal';
    const amount = reached ? output.amount : `-${output.amount}`;
    const row = await insertBalanceTransaction(tx, {
      publicId: newId('txn'),
      merchantId: intent.merchantId,
      connectedAccountId: output.connectedAccountId,
      // Output 0 keeps the key every earlier (one-output) entry was posted under.
      ingestionKey:
        output.position === 0
          ? `faircoin:${intent.id}:${String(own.length)}`
          : `faircoin:${intent.id}:${String(output.position)}:${String(own.length)}`,
      provider: null,
      providerObjectId: null,
      amount,
      // Orbit takes nothing on FairCoin (ADR 0012 D12, ADR 0021 D6): the payee
      // receives its whole share, and the payer pays the network fee.
      fee: '0',
      net: amount,
      currency: 'FAIR',
      type,
      reportingCategory: 'faircoin',
      status: 'informational',
      availableOn: null,
      occurredAt: intent.updatedAt,
      description: null,
      exchangeRate: null,
      // A fiat order paid in FairCoin: the ORDER's quote it was priced at
      // (ADR 0021 D7), beside the FAIR figures — never a conversion.
      faircoinQuote: intent.faircoinQuote ?? null,
      feeDetails: [],
      sourceType: 'payment_intent',
      sourceId: intent.publicId,
      paymentIntentId: intent.id,
      payoutId: null,
    });
    if (!row) continue;
    const signed = BigInt(amount);
    await postJournal(tx, row, 'recognized', [
      { balanceType: 'informational', amount: signed },
      { balanceType: 'external', amount: -signed },
    ]);
  }
}

export interface BalanceFigures {
  readonly available: { amount: string; currency: string }[];
  readonly pending: { amount: string; currency: string }[];
  readonly informational: { amount: string; currency: string }[];
}

/** A balance, per currency, from the ledger entries. Currencies with no entry are absent. */
export async function readBalance(scope: LedgerScope): Promise<BalanceFigures> {
  const rows = await readLedgerBalance(getDb(), scope);
  const out: BalanceFigures = { available: [], pending: [], informational: [] };
  for (const row of rows) {
    if (row.balanceType === 'external') continue;
    out[row.balanceType].push({ amount: row.amount, currency: row.currency });
  }
  // A currency that has activity in one bucket is reported in both payable
  // buckets, so `available` and `pending` describe the same currencies.
  const payable = new Set([...out.available, ...out.pending].map((entry) => entry.currency));
  for (const currency of payable) {
    if (!out.available.some((entry) => entry.currency === currency))
      out.available.push({ amount: '0', currency });
    if (!out.pending.some((entry) => entry.currency === currency))
      out.pending.push({ amount: '0', currency });
  }
  return out;
}
