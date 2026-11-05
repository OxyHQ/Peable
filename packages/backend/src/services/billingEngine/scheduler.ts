/**
 * The billing engine's scheduler (ADR 0018 §5): renewals, trial ends, draft
 * auto-advance, dunning retries — one leased, idempotent worker per process.
 *
 * ## No job table
 *
 * Every subscription and invoice carries `next_action_at`, the one instant its
 * next obligation falls due, rewritten by every change. A pass claims due rows
 * with `FOR UPDATE SKIP LOCKED` and a lease (`lease_expires_at`), so N tasks
 * share the work without a leader and a row is worked by one task at a time;
 * a task that dies mid-row leaves a lease that expires, and the next pass
 * takes the row again.
 *
 * ## Idempotent by construction, not by the lease
 *
 * The lease only avoids duplicate WORK. Correctness is the row's own: every
 * step re-reads the row under its lock and acts only if the obligation is
 * still due, a renewal invoice is unique per subscription period
 * (`invoices_subscription_period_reason_key`), every status write is a CAS,
 * and a payment attempt is keyed by the invoice and its attempt number. Two
 * workers that both claimed a row (a lease that ran out mid-step) produce one
 * outcome.
 *
 * ## Time
 *
 * "Due" is judged on each row's OWN clock — a test clock's `frozen_time` when
 * it lives on one, `now()` otherwise — in the claim statement itself.
 * Advancing a test clock runs passes for that clock until nothing on it is due.
 */
import {
  claimDueInvoices,
  findInvoiceById,
  lockInvoice,
  releaseInvoiceLease,
  clockHasDueInvoices,
} from '../../db/billingEngine/invoiceRepository';
import { ensureBillingSettings } from '../../db/billingEngine/settingsRepository';
import {
  claimDueSubscriptions,
  clockHasDueSubscriptions,
  findSubscriptionById,
  lockSubscription,
  releaseSubscriptionLease,
} from '../../db/billingEngine/subscriptionRepository';
import { getDb } from '../../db/postgres';
import { kickWebhookOutbox } from '../webhookOutbox';
import {
  attemptInvoicePayment,
  recordMissingPaymentMethod,
  runFinalDunningAction,
} from './collect';
import { finalizeStoredInvoice, markUncollectibleInTx } from './invoiceEngine';
import { InvoiceTaxError } from './invoiceTax';
import { addDays } from './periods';
import { engineNow } from './runtime';
import { runSubscriptionStep } from './subscriptions';
import { patchInvoice, StaleTransitionError, transitionSubscription } from './transitions';

const PASS_INTERVAL_MS = 30_000;
const BATCH = 50;
/** Long enough for a step with provider calls; short enough that a dead task's rows come back soon. */
const LEASE_SECONDS = 120;

/** One invoice's due obligation. */
export async function runInvoiceStep(invoiceId: string): Promise<void> {
  const db = getDb();
  const invoice = await findInvoiceById(db, invoiceId);
  if (!invoice || invoice.nextActionAt === null) return;
  const now = await engineNow(db, invoice.testClockId);
  if (invoice.nextActionAt.getTime() > now.getTime()) return;

  if (invoice.status === 'draft') {
    if (
      invoice.autoAdvance &&
      invoice.automaticallyFinalizesAt &&
      invoice.automaticallyFinalizesAt <= now
    ) {
      try {
        const finalized = await finalizeStoredInvoice(invoice.id);
        await applyPauseToFinalized(finalized.id);
      } catch (error) {
        // Recorded on the draft (and retried) by the finalize itself.
        if (!(error instanceof InvoiceTaxError)) throw error;
      }
      return;
    }
    await clearNextAction(invoice.id);
    return;
  }

  if (invoice.status === 'open' || invoice.status === 'uncollectible') {
    if (invoice.collectionMethod === 'charge_automatically') {
      if (invoice.dunningExhaustedAt !== null || invoice.nextPaymentAttempt === null) {
        await clearNextAction(invoice.id);
        return;
      }
      if (await applyPauseToFinalized(invoice.id)) return;
      if (invoice.nextPaymentAttempt <= now) {
        const outcome = await attemptInvoicePayment(invoice.id, { offSession: true });
        if (outcome.kind === 'no_payment_method') await recordMissingPaymentMethod(invoice.id);
        return;
      }
      const attemptAt = invoice.nextPaymentAttempt;
      await db.transaction(async (tx) => {
        const locked = await lockInvoice(tx, invoice.id);
        if (locked) await patchInvoice(tx, locked, { nextActionAt: attemptAt }, { record: false });
      });
      return;
    }
    // send_invoice: overdue → the subscription is past due; then, the
    // schedule's length later, the final action.
    if (invoice.dueDate && invoice.dueDate <= now && invoice.dunningExhaustedAt === null) {
      const settings = await ensureBillingSettings(db, invoice.merchantId);
      const window = settings.retryScheduleDays.reduce((sum, days) => sum + days, 0);
      const finalAt = addDays(invoice.dueDate, window);
      await db.transaction(async (tx) => {
        const locked = await lockInvoice(tx, invoice.id);
        if (locked?.status !== 'open') return;
        if (finalAt <= now) {
          await runFinalDunningAction(tx, locked, now);
          return;
        }
        if (locked.subscriptionId) {
          const subscription = await lockSubscription(tx, locked.subscriptionId);
          if (subscription?.status === 'active' && subscription.latestInvoiceId === locked.id) {
            await transitionSubscription(tx, subscription, 'past_due');
          }
        }
        await patchInvoice(tx, locked, { nextActionAt: finalAt }, { record: false });
      });
      kickWebhookOutbox();
      return;
    }
  }
  await clearNextAction(invoice.id);
}

/**
 * A subscription whose collection is paused to `mark_uncollectible`: its
 * finalized renewal is marked uncollectible instead of attempted.
 */
async function applyPauseToFinalized(invoiceId: string): Promise<boolean> {
  const db = getDb();
  const invoice = await findInvoiceById(db, invoiceId);
  if (!invoice?.subscriptionId || invoice.status !== 'open') return false;
  const subscription = await findSubscriptionById(db, invoice.subscriptionId);
  if (subscription?.pauseBehavior !== 'mark_uncollectible') return false;
  if (invoice.billingReason !== 'subscription_cycle') return false;
  await db.transaction(async (tx) => {
    const locked = await lockInvoice(tx, invoiceId);
    if (locked?.status === 'open')
      await markUncollectibleInTx(tx, locked, await engineNow(tx, locked.testClockId));
  });
  kickWebhookOutbox();
  return true;
}

async function clearNextAction(invoiceId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const locked = await lockInvoice(tx, invoiceId);
    if (locked && locked.nextActionAt !== null) {
      await patchInvoice(tx, locked, { nextActionAt: null }, { record: false });
    }
  });
}

export interface PassResult {
  readonly subscriptions: number;
  readonly invoices: number;
}

/**
 * One pass: claim what is due, work each row, release its lease. A row whose
 * step fails is logged and released; its `next_action_at` is unchanged, so
 * the next pass tries again.
 */
export async function runBillingEnginePass(
  options: { readonly testClockId?: string; readonly limit?: number } = {},
): Promise<PassResult> {
  const db = getDb();
  const claim = {
    limit: options.limit ?? BATCH,
    leaseSeconds: LEASE_SECONDS,
    ...(options.testClockId ? { testClockId: options.testClockId } : {}),
  };
  const subscriptionIds = await claimDueSubscriptions(db, claim);
  for (const id of subscriptionIds) {
    try {
      await runSubscriptionStep(id);
    } catch (error) {
      if (!(error instanceof StaleTransitionError)) {
        console.error(`[billing engine] subscription ${id}: ${(error as Error).message}`);
      }
    } finally {
      await releaseSubscriptionLease(db, id);
    }
  }
  const invoiceIds = await claimDueInvoices(db, claim);
  for (const id of invoiceIds) {
    try {
      await runInvoiceStep(id);
    } catch (error) {
      if (!(error instanceof StaleTransitionError)) {
        console.error(`[billing engine] invoice ${id}: ${(error as Error).message}`);
      }
    } finally {
      await releaseInvoiceLease(db, id);
    }
  }
  return { subscriptions: subscriptionIds.length, invoices: invoiceIds.length };
}

/**
 * Run passes for one test clock until nothing on it is due at its frozen time
 * (or a bound is hit — an obligation that keeps rescheduling itself into the
 * past is a defect, and the clock reports `internal_failure`).
 */
export async function drainTestClock(testClockId: string): Promise<boolean> {
  const db = getDb();
  for (let pass = 0; pass < 500; pass += 1) {
    const result = await runBillingEnginePass({ testClockId, limit: BATCH });
    if (result.subscriptions === 0 && result.invoices === 0) {
      const busy =
        (await clockHasDueSubscriptions(db, testClockId)) ||
        (await clockHasDueInvoices(db, testClockId));
      if (!busy) return true;
    }
  }
  return false;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runBillingEnginePass();
  } catch (error) {
    console.error(`[billing engine] pass failed: ${(error as Error).message}`);
  } finally {
    running = false;
  }
}

/** Start the per-process worker. `.unref()`-ed: it never holds the process open. */
export function startBillingEngine(intervalMs = PASS_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
}

export function stopBillingEngine(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Ask for a pass now rather than at the next tick. */
export function kickBillingEngine(): void {
  if (timer) void tick();
}
