/**
 * The billing engine's customer emails (ADR 0018), through Orbit's ONE
 * transactional email outbox (`services/email/*`, Orbit Phase 3): an email is
 * OWED in the transaction of the change it reports and SENT by the dispatcher
 * after the commit, through the injected `Mailer` (Oxy's outbound mail relay).
 *
 * - `invoice`: a finalized `send_invoice` invoice (when the merchant's billing
 *   settings send them), or `POST /v1/invoices/:id/send`;
 * - `invoice_payment_failed`: a failed automatic payment (dunning), when on.
 *
 * `invoice.sent` and `sent_at` are recorded only once the relay ACCEPTED the
 * invoice's email ({@link recordInvoiceSent}, called by the dispatcher) —
 * never for an email that is merely owed.
 */
import { randomUUID } from 'node:crypto';
import { lockInvoice, type InvoiceRow } from '../../db/billingEngine/invoiceRepository';
import { ensureBillingSettings } from '../../db/billingEngine/settingsRepository';
import { getDb, type Transaction } from '../../db/postgres';
import { renderInvoice } from '../../lib/serializeBilling';
import { enqueueInvoiceEmail } from '../email/outbox';
import { kickWebhookOutbox } from '../webhookOutbox';
import { BillingEngineError } from './errors';
import { engineNow } from './runtime';
import { patchInvoice, recordBillingEvent } from './transitions';

/** A finalized `send_invoice` invoice: its email is owed, when the merchant sends them. */
export async function oweInvoiceEmailOnFinalize(
  tx: Transaction,
  invoice: InvoiceRow,
): Promise<void> {
  const settings = await ensureBillingSettings(tx, invoice.merchantId);
  if (!settings.emailInvoiceFinalized) return;
  await enqueueInvoiceEmail(tx, invoice, 'invoice', 'finalized');
}

/** `POST /v1/invoices/:id/send`: a new email is owed, whatever the settings say. */
export async function oweInvoiceEmailNow(tx: Transaction, invoice: InvoiceRow): Promise<void> {
  const owed = await enqueueInvoiceEmail(tx, invoice, 'invoice', `send-${randomUUID()}`);
  if (!owed) {
    throw new BillingEngineError(
      'parameter_missing',
      'the invoice has no customer email to send it to; set the customer email before finalizing',
    );
  }
}

/** A failed automatic attempt: the dunning notice is owed (once per attempt), when on. */
export async function owePaymentFailedEmail(tx: Transaction, invoice: InvoiceRow): Promise<void> {
  const settings = await ensureBillingSettings(tx, invoice.merchantId);
  if (!settings.emailPaymentFailed) return;
  await enqueueInvoiceEmail(
    tx,
    invoice,
    'invoice_payment_failed',
    `attempt-${invoice.attemptCount}`,
  );
}

/** The relay accepted an invoice's email: `sent_at` and `invoice.sent`. */
export async function recordInvoiceSent(invoiceId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const locked = await lockInvoice(tx, invoiceId);
    if (!locked) return;
    const now = await engineNow(tx, locked.testClockId);
    const row = await patchInvoice(tx, locked, { sentAt: now }, { record: false });
    await recordBillingEvent(tx, row.merchantId, 'invoice.sent', await renderInvoice(tx, row));
  });
  kickWebhookOutbox();
}
