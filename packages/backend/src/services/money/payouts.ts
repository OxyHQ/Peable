/**
 * Payouts (ADR 0015 §4–§5): mirrored from the provider, and — for an account on
 * a MANUAL schedule — instructed through it. The provider executes every
 * payout from the account's own balance; Orbit never moves the money and has no
 * balance of its own to move it from.
 */
import type { PayoutStatus, WebhookEventType } from '@peable.to/shared-types';
import {
  findAccountByProviderAccountId,
  hasCardHalf,
  type CardConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import {
  findPayoutByProviderObject,
  insertPayoutInstruction,
  linkPayoutInstruction,
  markPayoutTransactionsSynced,
  upsertProviderPayout,
  type PayoutRow,
} from '../../db/money/payoutRepository';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { toPayoutDTO } from '../../lib/serializeMoney';
import { recordEvent } from '../events';
import { ProviderError, type ProviderId, type ProviderPayout } from '../providers/provider';
import { kickWebhookOutbox } from '../webhookOutbox';
import { assertLiveMoneyAllowed } from './chargeRouting';
import { ingestProviderTransactions, requireMirroringProvider } from './ledger';

/** The account's schedule pays out by itself; a manual payout is not accepted. 400. */
export class PayoutNotManualError extends Error {
  constructor() {
    super(
      "this account is paid out on an automatic schedule; set settings.payouts.schedule.interval to 'manual' to instruct payouts",
    );
    this.name = 'PayoutNotManualError';
  }
}

/** The payout cannot be canceled in its state. 400. */
export class PayoutNotCancelableError extends Error {
  constructor(status: PayoutStatus) {
    super(`a ${status} payout cannot be canceled`);
    this.name = 'PayoutNotCancelableError';
  }
}

/** Which event a mirrored change is, by where the payout landed. */
function eventFor(before: PayoutRow | null, after: PayoutRow): WebhookEventType | null {
  if (before === null) return 'payout.created';
  if (before.status !== after.status) {
    if (after.status === 'paid') return 'payout.paid';
    if (after.status === 'failed') return 'payout.failed';
    if (after.status === 'canceled') return 'payout.canceled';
    return 'payout.updated';
  }
  const moved =
    before.amount !== after.amount ||
    before.arrivalDate?.getTime() !== after.arrivalDate?.getTime() ||
    before.failureCode !== after.failureCode;
  return moved ? 'payout.updated' : null;
}

async function recordPayoutEvent(
  tx: DatabaseOrTransaction,
  type: WebhookEventType,
  payout: PayoutRow,
  before: PayoutRow | null,
): Promise<void> {
  await recordEvent(tx, {
    merchantId: payout.merchantId,
    type: type as 'payout.created',
    object: toPayoutDTO(payout),
    account: payout.connectedAccountPublicId,
    ...(before && before.status !== payout.status
      ? { previousAttributes: { status: before.status } }
      : {}),
  });
}

/**
 * Mirror one provider payout and tell the merchant what changed, in one
 * transaction (ADR 0001 D7). Once it is `paid`, its balance transactions are
 * read (`payout=` filter) and attached, so the reconciliation report is complete.
 */
export async function applyProviderPayout(
  account: CardConnectedAccountRow,
  payout: ProviderPayout,
): Promise<PayoutRow> {
  const { before, after } = await getDb().transaction(async (tx) => {
    const result = await upsertProviderPayout(tx, {
      publicId: newId('po'),
      merchantId: account.merchantId,
      connectedAccountId: account.id,
      provider: account.provider,
      payout,
    });
    const type = eventFor(result.before, result.after);
    if (type) await recordPayoutEvent(tx, type, result.after, result.before);
    return result;
  });
  if (
    after.status === 'paid' &&
    (before?.status !== 'paid' || after.transactionsSyncedAt === null)
  ) {
    await syncPayoutTransactions(account, after);
  }
  kickWebhookOutbox();
  return after;
}

/** Read every balance transaction a payout paid out, and attach them to it. */
export async function syncPayoutTransactions(
  account: CardConnectedAccountRow,
  payout: PayoutRow,
): Promise<void> {
  if (!payout.providerObjectId) return;
  const provider = requireMirroringProvider(account.provider, account.livemode);
  let startingAfter: string | undefined;
  for (;;) {
    const page = await provider.listBalanceTransactions({
      account: account.providerAccountId,
      payout: payout.providerObjectId,
      limit: 100,
      ...(startingAfter !== undefined ? { startingAfter } : {}),
    });
    await ingestProviderTransactions(
      {
        merchantId: account.merchantId,
        connectedAccountId: account.id,
        provider: account.provider,
        payoutId: payout.id,
      },
      page.data,
    );
    const last = page.data.at(-1);
    if (!page.hasMore || !last) break;
    startingAfter = last.providerObjectId;
  }
  await markPayoutTransactionsSynced(getDb(), payout.id);
}

/** A provider `payout.*` event: re-read the payout and mirror it. */
export async function handlePayoutEvent(
  provider: ProviderId,
  providerAccountId: string,
  providerPayoutId: string,
): Promise<'applied' | 'unmatched'> {
  const account = await findAccountByProviderAccountId(getDb(), provider, providerAccountId);
  if (!account || !hasCardHalf(account)) return 'unmatched';
  const adapter = requireMirroringProvider(account.provider, account.livemode);
  const payout = await adapter.getPayout(account.providerAccountId, providerPayoutId);
  await applyProviderPayout(account, payout);
  return 'applied';
}

export interface CreatePayoutInput {
  readonly account: CardConnectedAccountRow;
  readonly amount: string;
  readonly currency: string;
  readonly method: 'standard' | 'instant';
  readonly description?: string;
  readonly statementDescriptor?: string;
  readonly metadata: Record<string, string>;
}

/**
 * Instruct a payout. Row first, provider second, under an idempotency key
 * derived from the row — a crash between the two leaves an instruction the
 * same key finishes, never a second payout.
 *
 * @throws {PayoutNotManualError} on an automatic schedule.
 * @throws {ThirdPartyLiveGateError} live, for a non-Oxy merchant, behind the gate.
 */
export async function createPayout(input: CreatePayoutInput): Promise<PayoutRow> {
  const { account } = input;
  const merchant = await findMerchantById(getDb(), account.merchantId);
  if (!merchant) throw new Error(`account ${account.publicId} names no merchant`);
  assertLiveMoneyAllowed(merchant, 'a payout');
  if (account.settings?.payouts.schedule?.interval !== 'manual') throw new PayoutNotManualError();
  const provider = requireMirroringProvider(account.provider, account.livemode);

  const instruction = await insertPayoutInstruction(getDb(), {
    publicId: newId('po'),
    merchantId: account.merchantId,
    connectedAccountId: account.id,
    provider: account.provider,
    amount: input.amount,
    currency: input.currency,
    method: input.method,
    description: input.description ?? null,
    statementDescriptor: input.statementDescriptor ?? null,
    metadata: input.metadata,
  });
  const payout = await provider.createPayout({
    account: account.providerAccountId,
    payoutId: instruction.publicId,
    amount: input.amount,
    currency: input.currency,
    method: input.method,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.statementDescriptor !== undefined
      ? { statementDescriptor: input.statementDescriptor }
      : {}),
    idempotencyKey: `po:${instruction.publicId}`,
  });
  const linked = await getDb().transaction(async (tx) => {
    const row = await linkPayoutInstruction(tx, instruction.id, account.provider, payout);
    // The provider's own `payout.created` may have arrived first and claimed
    // the object; its row is this payout.
    const current =
      row ?? (await findPayoutByProviderObject(tx, account.provider, payout.providerObjectId));
    if (!current) throw new Error(`payout ${instruction.publicId} neither linked nor found`);
    if (row) await recordPayoutEvent(tx, 'payout.created', row, null);
    return current;
  });
  kickWebhookOutbox();
  return linked;
}

/** Cancel a payout the provider has not yet sent. */
export async function cancelPayout(
  account: CardConnectedAccountRow,
  payout: PayoutRow,
): Promise<PayoutRow> {
  if (payout.status !== 'pending' || !payout.providerObjectId) {
    throw new PayoutNotCancelableError(payout.status);
  }
  const provider = requireMirroringProvider(account.provider, account.livemode);
  try {
    const canceled = await provider.cancelPayout({
      account: account.providerAccountId,
      providerObjectId: payout.providerObjectId,
      idempotencyKey: `po_cancel:${payout.publicId}`,
    });
    return await applyProviderPayout(account, canceled);
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      throw new PayoutNotCancelableError(payout.status);
    }
    throw error;
  }
}
