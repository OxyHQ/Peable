/**
 * The customer-email dispatcher (Orbit Phase 3): claims owed emails, renders
 * each at send time and hands it to the injected mailer. A refusal of the
 * message itself is `failed`; a transport failure backs off (1, 5, 30 minutes,
 * then hourly) until the email's window closes, when it is `expired` — a
 * receipt days late is worse than none. No mailer configured: nothing is
 * claimed, and rows wait (then expire).
 */
import { getDb } from '../../db/postgres';
import { currentMailer, MailerRefusedError, type Mailer } from './mailer';
import { claimOwedEmails, markEmailFailed, markEmailSent } from './outbox';
import { renderOwedEmail } from './render';
import { recordInvoiceSent } from '../billingEngine/notices';

const BACKOFF_MINUTES = [1, 5, 30, 60];
const DEFAULT_INTERVAL_MS = 15_000;
const BATCH = 20;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One pass: send what is due. Returns how many were sent. */
export async function dispatchCustomerEmails(
  mailer: Mailer | null = currentMailer(),
  now: () => Date = () => new Date(),
): Promise<number> {
  if (!mailer) return 0;
  const db = getDb();
  const owed = await claimOwedEmails(db, BATCH);
  let sent = 0;
  for (const row of owed) {
    if (row.expiresAt.getTime() <= now().getTime()) {
      await markEmailFailed(db, row.id, { status: 'expired' }, 'the send window closed');
      continue;
    }
    let email: Awaited<ReturnType<typeof renderOwedEmail>>;
    try {
      email = await renderOwedEmail(db, row);
    } catch (error) {
      await markEmailFailed(
        db,
        row.id,
        { retryAt: new Date(now().getTime() + 60_000) },
        describe(error),
      );
      continue;
    }
    if (!email) {
      await markEmailFailed(
        db,
        row.id,
        { status: 'failed' },
        'what this email reports no longer exists',
      );
      continue;
    }
    try {
      await mailer.send(email);
      await markEmailSent(db, row.id);
      // An invoice is `sent` (ADR 0018) only once the relay took its email.
      if (row.kind === 'invoice' && row.invoiceId) await recordInvoiceSent(row.invoiceId);
      sent += 1;
    } catch (error) {
      if (error instanceof MailerRefusedError) {
        await markEmailFailed(db, row.id, { status: 'failed' }, describe(error));
      } else {
        const minutes =
          BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 60;
        await markEmailFailed(
          db,
          row.id,
          { retryAt: new Date(now().getTime() + minutes * 60_000) },
          describe(error),
        );
      }
    }
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the loop (boot). `.unref()`ed so it never holds a test run open. */
export function startCustomerEmailDispatcher(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    dispatchCustomerEmails().catch((error: unknown) => {
      console.error('customer email dispatch failed:', describe(error));
    });
  }, intervalMs);
  timer.unref();
}

export function stopCustomerEmailDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
