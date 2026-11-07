/**
 * The customer-email outbox (Orbit Phase 3): an email is OWED in the
 * transaction of the change it reports, and SENT by the dispatcher after the
 * commit — the webhook outbox's shape (ADR 0001 D7), for the same reason: a
 * crash between "the payment succeeded" and "the receipt was sent" must leave
 * a row that says a receipt is owed, not nothing.
 *
 * Each enqueue respects the merchant's email settings and needs a recipient:
 * a receipt goes to the payment's `receipt_email` (a checkout session sets it
 * from the email the payer gave). `dedupe_key` makes it idempotent.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { claimReceiptNumber, findEmailSettings } from '../../db/merchants/brandingRepository';
import type { CheckoutSessionRow } from '../../db/payments/checkoutSessionRepository';
import type { PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import type { DatabaseOrTransaction } from '../../db/postgres';
import type { ReportRunRow } from '../../db/reporting/reportRunRepository';
import { customerEmails, refunds, reportSchedules } from '../../db/schema';
import type { CustomerEmailKind } from '../../db/schema/valueSets';

/** How long an unsent email is still worth sending. */
export const EMAIL_SEND_WINDOW_MS = 3 * 24 * 3600_000;

const EMAIL = /^[^@\s]+@[^@\s]+$/;

async function alreadyOwed(db: DatabaseOrTransaction, dedupeKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: customerEmails.id })
    .from(customerEmails)
    .where(eq(customerEmails.dedupeKey, dedupeKey));
  return row !== undefined;
}

async function insertOwed(
  db: DatabaseOrTransaction,
  values: {
    merchantId: string;
    kind: CustomerEmailKind;
    dedupeKey: string;
    recipient: string;
    paymentIntentId?: string;
    refundId?: string;
    checkoutSessionId?: string;
    invoiceId?: string;
    receiptNumber?: string;
    reportRunId?: string;
  },
): Promise<void> {
  await db
    .insert(customerEmails)
    .values({
      id: uuidv7(),
      ...values,
      expiresAt: new Date(Date.now() + EMAIL_SEND_WINDOW_MS),
    })
    .onConflictDoNothing();
}

/** A receipt number as printed: the merchant's sequence, zero-padded. */
export function formatReceiptNumber(n: number): string {
  return `R-${String(n).padStart(6, '0')}`;
}

/** A payment just succeeded: its receipt is owed (if it has an email and the merchant sends them). */
export async function enqueuePaymentReceipt(
  tx: DatabaseOrTransaction,
  intent: PaymentIntentRow,
): Promise<void> {
  if (intent.status !== 'succeeded' || !intent.receiptEmail || !EMAIL.test(intent.receiptEmail)) {
    return;
  }
  const dedupeKey = `payment_receipt:${intent.id}`;
  if (await alreadyOwed(tx, dedupeKey)) return;
  const settings = await findEmailSettings(tx, intent.merchantId);
  if (!settings.paymentReceipts) return;
  const number = await claimReceiptNumber(tx, intent.merchantId);
  await insertOwed(tx, {
    merchantId: intent.merchantId,
    kind: 'payment_receipt',
    dedupeKey,
    recipient: intent.receiptEmail,
    paymentIntentId: intent.id,
    receiptNumber: formatReceiptNumber(number),
  });
}

/** A refund succeeded: a notice is owed to the payment's receipt email. */
export async function enqueueRefundNotice(
  tx: DatabaseOrTransaction,
  intent: PaymentIntentRow,
  refundPublicId: string,
): Promise<void> {
  if (!intent.receiptEmail || !EMAIL.test(intent.receiptEmail)) return;
  const [refund] = await tx
    .select({ id: refunds.id, status: refunds.status })
    .from(refunds)
    .where(and(eq(refunds.publicId, refundPublicId), eq(refunds.merchantId, intent.merchantId)));
  if (refund?.status !== 'succeeded') return;
  const dedupeKey = `refund_notice:${refund.id}`;
  if (await alreadyOwed(tx, dedupeKey)) return;
  const settings = await findEmailSettings(tx, intent.merchantId);
  if (!settings.refundNotices) return;
  await insertOwed(tx, {
    merchantId: intent.merchantId,
    kind: 'refund_notice',
    dedupeKey,
    recipient: intent.receiptEmail,
    paymentIntentId: intent.id,
    refundId: refund.id,
  });
}

/** A checkout session completed: its confirmation is owed (off by default). */
export async function enqueueCheckoutConfirmation(
  tx: DatabaseOrTransaction,
  session: CheckoutSessionRow,
): Promise<void> {
  const email = session.customerEmail ?? session.customerDetails?.email ?? null;
  if (!email || !EMAIL.test(email)) return;
  const dedupeKey = `checkout_confirmation:${session.id}`;
  if (await alreadyOwed(tx, dedupeKey)) return;
  const settings = await findEmailSettings(tx, session.merchantId);
  if (!settings.checkoutConfirmations) return;
  await insertOwed(tx, {
    merchantId: session.merchantId,
    kind: 'checkout_confirmation',
    dedupeKey,
    recipient: email,
    checkoutSessionId: session.id,
  });
}

/**
 * An invoice's email is owed (ADR 0018): `invoice` (sent for its customer to
 * pay — at finalization of a `send_invoice` invoice, or by `POST …/send`) or
 * `invoice_payment_failed` (dunning). `occasion` keeps each sending distinct:
 * a re-send is a new email, a retried finalization is not.
 */
export async function enqueueInvoiceEmail(
  tx: DatabaseOrTransaction,
  invoice: {
    readonly id: string;
    readonly merchantId: string;
    readonly customerEmail: string | null;
  },
  kind: 'invoice' | 'invoice_payment_failed',
  occasion: string,
): Promise<boolean> {
  const email = invoice.customerEmail;
  if (!email || !EMAIL.test(email)) return false;
  const dedupeKey = `${kind}:${invoice.id}:${occasion}`;
  if (await alreadyOwed(tx, dedupeKey)) return true;
  await insertOwed(tx, {
    merchantId: invoice.merchantId,
    kind,
    dedupeKey,
    recipient: email,
    invoiceId: invoice.id,
  });
  return true;
}

/**
 * A scheduled report run finished: each of its schedule's recipients is owed
 * a `report_run_succeeded` (or `report_run_failed`) email, in the transaction
 * that completed the run. Deduplicated per run and recipient. A run asked for
 * directly emails nobody, and neither does one whose schedule was canceled.
 *
 * The email links to the run in Orbit and never carries the file: a report
 * is private (`finance_report_run`, readable only through an authorized
 * `GET /v1/files/:id/contents`), so a recipient signs in as a member.
 */
export async function enqueueReportRunEmails(
  tx: DatabaseOrTransaction,
  run: Pick<ReportRunRow, 'id' | 'merchantId' | 'status' | 'reportScheduleId'>,
): Promise<number> {
  if (run.reportScheduleId === null || run.status === 'pending') return 0;
  const [schedule] = await tx
    .select({ recipients: reportSchedules.recipients, status: reportSchedules.status })
    .from(reportSchedules)
    .where(eq(reportSchedules.id, run.reportScheduleId));
  if (!schedule || schedule.status === 'canceled') return 0;
  const kind = run.status === 'succeeded' ? 'report_run_succeeded' : 'report_run_failed';
  let owed = 0;
  for (const recipient of schedule.recipients) {
    if (!EMAIL.test(recipient) || recipient.length > 254) continue;
    const dedupeKey = `${kind}:${run.id}:${recipient.toLowerCase()}`;
    if (await alreadyOwed(tx, dedupeKey)) continue;
    await insertOwed(tx, {
      merchantId: run.merchantId,
      kind,
      dedupeKey,
      recipient,
      reportRunId: run.id,
    });
    owed += 1;
  }
  return owed;
}

// ---- The dispatcher's reads and writes ----------------------------------------------

export interface OwedEmailRow {
  readonly id: string;
  readonly merchantId: string;
  readonly kind: CustomerEmailKind;
  readonly recipient: string;
  readonly paymentIntentId: string | null;
  readonly refundId: string | null;
  readonly checkoutSessionId: string | null;
  readonly invoiceId: string | null;
  readonly receiptNumber: string | null;
  readonly reportRunId: string | null;
  readonly attempts: number;
  readonly expiresAt: Date;
}

/** How long a claimed row is the claimer's before another task may take it. */
const CLAIM_LEASE = sql`interval '5 minutes'`;

/**
 * Claim up to `limit` due emails — ONE statement, `for update skip locked`,
 * pushing `next_attempt_at` forward as the lease so two tasks never send one.
 */
export async function claimOwedEmails(
  db: DatabaseOrTransaction,
  limit: number,
): Promise<OwedEmailRow[]> {
  const due = db
    .select({ id: customerEmails.id })
    .from(customerEmails)
    .where(and(eq(customerEmails.status, 'pending'), lte(customerEmails.nextAttemptAt, sql`now()`)))
    .orderBy(customerEmails.nextAttemptAt)
    .limit(limit)
    .for('update', { skipLocked: true });
  const rows = await db
    .update(customerEmails)
    .set({
      nextAttemptAt: sql`now() + ${CLAIM_LEASE}`,
      attempts: sql`${customerEmails.attempts} + 1`,
    })
    .where(sql`${customerEmails.id} in (${due})`)
    .returning({
      id: customerEmails.id,
      merchantId: customerEmails.merchantId,
      kind: customerEmails.kind,
      recipient: customerEmails.recipient,
      paymentIntentId: customerEmails.paymentIntentId,
      refundId: customerEmails.refundId,
      checkoutSessionId: customerEmails.checkoutSessionId,
      invoiceId: customerEmails.invoiceId,
      receiptNumber: customerEmails.receiptNumber,
      reportRunId: customerEmails.reportRunId,
      attempts: customerEmails.attempts,
      expiresAt: customerEmails.expiresAt,
    });
  return rows as OwedEmailRow[];
}

export async function markEmailSent(db: DatabaseOrTransaction, id: string): Promise<void> {
  await db
    .update(customerEmails)
    .set({ status: 'sent', sentAt: sql`date_trunc('milliseconds', now())`, lastError: null })
    .where(and(eq(customerEmails.id, id), eq(customerEmails.status, 'pending')));
}

export async function markEmailFailed(
  db: DatabaseOrTransaction,
  id: string,
  outcome: { readonly status: 'failed' | 'expired' } | { readonly retryAt: Date },
  error: string,
): Promise<void> {
  await db
    .update(customerEmails)
    .set(
      'status' in outcome
        ? { status: outcome.status, lastError: error.slice(0, 500) }
        : { nextAttemptAt: outcome.retryAt, lastError: error.slice(0, 500) },
    )
    .where(and(eq(customerEmails.id, id), eq(customerEmails.status, 'pending')));
}
