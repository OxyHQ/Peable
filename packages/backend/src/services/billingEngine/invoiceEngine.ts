/**
 * The invoice lifecycle (ADR 0018): draft → open → paid | void | uncollectible.
 *
 * ## Finalizing is two steps, and the order is the point
 *
 * 1. {@link prepareInvoice} prices the draft — discounts with the catalog's
 *    pricing, then Peable Tax for every line (`invoiceTax.ts`). It may record
 *    neutral tax evidence/calculations and call the provider; failure leaves the draft a draft
 *    (fail closed).
 * 2. {@link commitFinalization} runs in ONE transaction: it proves the draft
 *    is still the one that was priced (the lines' digest), freezes every line's
 *    discount and tax, applies the customer's balance, takes the merchant's
 *    next invoice number (gapless: a rollback gives it back) and moves the
 *    invoice to `open` with `invoice.finalized`. An invoice whose amount due
 *    is zero is `paid` in the same transaction.
 *
 * Holding the numbering lock across a provider call would serialize every
 * finalize of a merchant behind a network round trip, which is why tax is
 * computed before the transaction opens and verified inside it.
 */
import type { CurrencyCode, InvoiceStatus } from '@peable.to/shared-types';
import { findCouponById, type CouponRow } from '../../db/catalog/couponRepository';
import { findCustomerById, type CustomerRow } from '../../db/customers/customerRepository';
import { findMerchantById, type MerchantRow } from '../../db/merchants/merchantRepository';
import {
  lockCustomerBalance,
  recordBalanceTransaction,
} from '../../db/billingEngine/balanceRepository';
import {
  deleteDraftInvoice,
  findInvoiceById,
  listLines,
  lockInvoice,
  setLineAmounts,
  findLinesByIds,
  type InvoiceRow,
} from '../../db/billingEngine/invoiceRepository';
import { formatInvoiceNumber, takeInvoiceNumber } from '../../db/billingEngine/settingsRepository';
import { lockSubscription } from '../../db/billingEngine/subscriptionRepository';
import { taxTransactions } from '../../db/schema';
import { type Transaction, getDb } from '../../db/postgres';
import { newBearerToken, newId } from '../../lib/ids';
import { renderInvoice } from '../../lib/serializeBilling';
import { commitTaxTransaction, reverseTaxTransaction } from '../tax/taxService';
import { kickWebhookOutbox } from '../webhookOutbox';
import { and, eq, isNull } from 'drizzle-orm';
import {
  type Catalog,
  type DraftLine,
  discountsFor,
  draftLineOf,
  linesDigest,
  loadCatalog,
} from './drafting';
import { BillingEngineError } from './errors';
import { applyBalance, invoiceTotals, type Totals } from './invoiceMath';
import { InvoiceTaxError, type InvoiceTax, taxInvoiceLines } from './invoiceTax';
import { addDays } from './periods';
import { engineNow } from './runtime';
import {
  patchInvoice,
  recordBillingEvent,
  transitionInvoice,
  transitionSubscription,
} from './transitions';
import { oweInvoiceEmailOnFinalize } from './notices';
import { reversePrePaymentNotes } from './creditNotes';
import {
  captureFinalizationInput,
  finalizationConflict,
  type FinalizationInput,
} from './finalizationRevision';

/** How long a draft with `auto_advance` waits before it finalizes (Stripe's hour). */
export const DRAFT_FINALIZATION_DELAY_MS = 3600_000;
/** How long after a failed tax calculation an auto-advancing draft tries again. */
export const FINALIZATION_RETRY_MS = 3600_000;

export interface PreparedInvoice {
  readonly lines: readonly DraftLine[];
  readonly catalog: Catalog;
  readonly coupon: CouponRow | null;
  readonly discounts: readonly bigint[];
  readonly tax: InvoiceTax;
  readonly totals: Totals;
  readonly digest: string;
}

/** Discounts and totals of a draft without tax — what a draft shows while it is edited. */
export function draftTotals(
  lines: readonly DraftLine[],
  discounts: readonly bigint[],
  automaticTax: boolean,
): Totals {
  return invoiceTotals({
    lines: lines.map((line, i) => ({
      amount: line.amount,
      discount: discounts[i] ?? 0n,
      taxExclusive: 0n,
      taxInclusive: 0n,
    })),
    taxed: !automaticTax,
  });
}

/**
 * Price a draft completely: discounts, then Peable Tax.
 *
 * @throws {InvoiceTaxError} when tax fails closed.
 */
export async function prepareInvoice(input: {
  readonly merchant: MerchantRow;
  readonly customer: CustomerRow;
  readonly currency: CurrencyCode;
  readonly automaticTax: boolean;
  readonly lines: readonly DraftLine[];
  readonly coupon: CouponRow | null;
  readonly captured?: FinalizationInput;
}): Promise<PreparedInvoice> {
  const db = getDb();
  const catalog =
    input.captured?.catalog ??
    (await loadCatalog(
      db,
      input.lines.map((line) => line.priceId),
    ));
  const discounts = discountsFor(input.lines, catalog, input.coupon, input.currency);
  const nets = input.lines.map((line, i) => line.amount - (discounts[i] ?? 0n));
  const tax = await taxInvoiceLines(db, {
    merchant: input.merchant,
    customer: input.customer,
    automaticTax: input.automaticTax,
    currency: input.currency,
    lines: input.lines,
    nets,
    catalog,
    ...(input.captured ? { captured: input.captured.tax } : {}),
  });
  const totals = invoiceTotals({
    lines: input.lines.map((line, i) => ({
      amount: line.amount,
      discount: discounts[i] ?? 0n,
      taxExclusive: tax.exclusive[i] ?? 0n,
      taxInclusive: tax.inclusive[i] ?? 0n,
    })),
    taxed: true,
  });
  return {
    lines: input.lines,
    catalog,
    coupon: input.coupon,
    discounts,
    tax,
    totals,
    digest: linesDigest(input.lines, input.coupon?.id ?? null, input.currency),
  };
}

/** What a committed finalization leaves for after the commit. */
export interface FinalizeOutcome {
  readonly invoice: InvoiceRow;
}

/**
 * Freeze a prepared draft and move it to `open` (and on to `paid` when
 * nothing is due), inside `tx`. The invoice row must be LOCKED by the caller.
 */
export async function commitFinalization(
  tx: Transaction,
  invoice: InvoiceRow,
  prepared: PreparedInvoice,
  now: Date,
  options: { readonly autoAdvance?: boolean; readonly acceptedFinalizationRevision?: string } = {},
): Promise<FinalizeOutcome> {
  if (invoice.status !== 'draft') {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      `this invoice is ${invoice.status}; only a draft can be finalized`,
    );
  }
  const stored = (await listLines(tx, invoice.id)).map(draftLineOf);
  if (linesDigest(stored, invoice.discountCouponId, invoice.currency) !== prepared.digest) {
    throw new BillingEngineError(
      'invoice_not_editable',
      'the invoice changed while it was being finalized; try again',
    );
  }
  for (const [i, line] of prepared.lines.entries()) {
    await setLineAmounts(tx, line.id, {
      discountAmount: (prepared.discounts[i] ?? 0n).toString(),
      taxAmounts: prepared.tax.taxAmounts[i] ?? [],
    });
  }
  const customer = await findCustomerById(tx, invoice.customerId);
  if (!customer) throw new Error(`customer ${invoice.customerId} vanished`);
  const held = await lockCustomerBalance(tx, invoice.customerId);
  const balance = held.currency === invoice.currency ? held.balance : 0n;
  const { totals } = prepared;
  const applied = applyBalance(totals.total, balance);
  if (applied.applied !== 0n) {
    const written = await recordBalanceTransaction(tx, {
      publicId: newId('cbtxn'),
      merchantId: invoice.merchantId,
      customerId: invoice.customerId,
      type: 'applied_to_invoice',
      amount: applied.applied,
      currency: invoice.currency,
      invoiceId: invoice.id,
    });
    if (written === 'currency_mismatch' || written === 'customer_missing') {
      throw new Error(`the customer balance refused the invoice: ${written}`);
    }
  }
  const taken = await takeInvoiceNumber(tx, invoice.merchantId);
  const dueDate =
    invoice.collectionMethod === 'send_invoice'
      ? (invoice.dueDate ?? addDays(now, invoice.daysUntilDue ?? 30))
      : null;
  const autoAdvance = options.autoAdvance ?? invoice.autoAdvance;
  const amountDue = applied.amountDue;
  let next: Date | null = null;
  if (amountDue > 0n) {
    next =
      invoice.collectionMethod === 'charge_automatically' ? (autoAdvance ? now : null) : dueDate;
  }
  let row = await transitionInvoice(tx, invoice, 'open', {
    number: formatInvoiceNumber(taken.prefix, taken.number),
    hostedToken: newBearerToken('inv'),
    finalizedAt: now,
    autoAdvance,
    automaticallyFinalizesAt: null,
    dueDate,
    customerEmail: customer.email,
    customerName: customer.name,
    subtotal: totals.subtotal.toString(),
    totalDiscount: totals.totalDiscount.toString(),
    tax: invoice.automaticTax ? (totals.tax ?? 0n).toString() : '0',
    total: totals.total.toString(),
    totalExcludingTax: totals.totalExcludingTax.toString(),
    startingBalance: balance.toString(),
    endingBalance: applied.endingBalance.toString(),
    amountDue: amountDue.toString(),
    automaticTaxStatus: invoice.automaticTax ? 'complete' : null,
    taxCalculationId: prepared.tax.calculation?.id ?? null,
    taxedLinesDigest: prepared.digest,
    acceptedFinalizationRevision: options.acceptedFinalizationRevision ?? null,
    lastFinalizationError: null,
    nextPaymentAttempt:
      invoice.collectionMethod === 'charge_automatically' && amountDue > 0n && autoAdvance
        ? now
        : null,
    nextActionAt: next,
  });
  if (amountDue === 0n) {
    row = await markInvoicePaid(tx, row, now, { amountPaid: 0n });
  }
  if (row.status === 'open' && row.collectionMethod === 'send_invoice') {
    await oweInvoiceEmailOnFinalize(tx, row);
  }
  return { invoice: row };
}

/** Load what a stored draft is priced from. */
export async function loadDraft(invoice: InvoiceRow): Promise<{
  merchant: MerchantRow;
  customer: CustomerRow;
  lines: DraftLine[];
  coupon: CouponRow | null;
}> {
  const db = getDb();
  const merchant = await findMerchantById(db, invoice.merchantId);
  const customer = await findCustomerById(db, invoice.customerId);
  if (!merchant || !customer) throw new Error('an invoice without its merchant or customer');
  const lines = (await listLines(db, invoice.id)).map(draftLineOf);
  const coupon = invoice.discountCouponId
    ? await findCouponById(db, invoice.discountCouponId)
    : null;
  return { merchant, customer, lines, coupon };
}

/**
 * Finalize a stored draft: prepare (outside any transaction), then commit.
 * A tax failure is recorded on the draft (`automatic_tax.status`,
 * `last_finalization_error`, and for an auto-advancing draft a retry in an
 * hour) and rethrown.
 */
export async function finalizeStoredInvoice(
  invoiceId: string,
  options: {
    readonly autoAdvance?: boolean;
    readonly manual?: boolean;
    readonly expectedFinalizationRevision?: string;
  } = {},
): Promise<InvoiceRow> {
  const db = getDb();
  const captured =
    options.expectedFinalizationRevision === undefined
      ? undefined
      : await db.transaction((tx) => captureFinalizationInput(tx, invoiceId), {
          isolationLevel: 'repeatable read',
          accessMode: 'read only',
        });
  if (
    captured &&
    (captured.revision !== options.expectedFinalizationRevision ||
      captured.invoice.status !== 'draft' ||
      (options.autoAdvance !== undefined && options.autoAdvance !== captured.invoice.autoAdvance))
  )
    throw finalizationConflict();
  const invoice = captured?.invoice ?? (await findInvoiceById(db, invoiceId));
  if (!invoice)
    throw new BillingEngineError('resource_missing', 'invoice not found', undefined, 404);
  if (invoice.status !== 'draft') {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      `this invoice is ${invoice.status}; only a draft can be finalized`,
    );
  }
  const draft = captured ?? (await loadDraft(invoice));
  if (options.manual && draft.lines.length === 0) {
    throw new BillingEngineError(
      'invoice_no_customer_line_items',
      'an invoice needs at least one line to be finalized',
    );
  }
  const now = await engineNow(db, invoice.testClockId);
  let prepared: PreparedInvoice;
  try {
    prepared = await prepareInvoice({
      merchant: draft.merchant,
      customer: draft.customer,
      currency: invoice.currency,
      automaticTax: invoice.automaticTax,
      lines: draft.lines,
      coupon: draft.coupon,
      ...(captured ? { captured } : {}),
    });
  } catch (error) {
    if (error instanceof InvoiceTaxError) {
      await db.transaction(async (tx) => {
        const locked = await lockInvoice(tx, invoice.id);
        if (locked?.status !== 'draft') return;
        await patchInvoice(
          tx,
          locked,
          {
            automaticTaxStatus: error.taxStatus,
            lastFinalizationError: { code: error.code, message: error.message },
            nextActionAt: locked.autoAdvance
              ? new Date(now.getTime() + FINALIZATION_RETRY_MS)
              : null,
          },
          { record: false },
        );
      });
    }
    throw error;
  }
  let outcome: FinalizeOutcome;
  try {
    outcome = await db.transaction(
      async (tx) => {
        const locked = await lockInvoice(tx, invoice.id);
        if (!locked) throw new Error('invoice vanished');
        if (captured) {
          const current = await captureFinalizationInput(tx, invoice.id);
          if (current.invoice.status !== 'draft' || current.revision !== captured.revision)
            throw finalizationConflict();
        }
        return commitFinalization(tx, locked, prepared, now, {
          ...options,
          ...(captured ? { acceptedFinalizationRevision: captured.revision } : {}),
        });
      },
      captured ? { isolationLevel: 'serializable' } : undefined,
    );
  } catch (error) {
    // A concurrent input write during revalidation is a stale approval, not a
    // reason to replay the financial operation automatically.
    if (captured && serializationConflict(error)) throw finalizationConflict();
    throw error;
  }
  kickWebhookOutbox();
  return (await findInvoiceById(db, invoice.id)) ?? outcome.invoice;
}

/**
 * `open`/`uncollectible` → `paid`, with what being paid means: the tax
 * calculation becomes a tax transaction (and every proration credit a
 * reversal of what it credits), and a subscription waiting on this invoice is
 * active again. On the caller's transaction (the payment's own, when a
 * PaymentIntent paid it).
 */
export async function markInvoicePaid(
  tx: Transaction,
  invoice: InvoiceRow,
  now: Date,
  options: {
    readonly amountPaid: bigint;
    readonly outOfBand?: boolean;
    /** A card attempt succeeded: it counts as an attempt. */
    readonly countAttempt?: boolean;
  },
): Promise<InvoiceRow> {
  const paid = await transitionInvoice(tx, invoice, 'paid', {
    paidAt: now,
    amountPaid: (BigInt(invoice.amountPaid) + options.amountPaid).toString(),
    nextPaymentAttempt: null,
    nextActionAt: null,
    ...(options.outOfBand ? { paidOutOfBand: true } : {}),
    ...(options.countAttempt ? { attemptCount: invoice.attemptCount + 1 } : {}),
  });
  await commitInvoiceTax(tx, paid, now);
  if (paid.subscriptionId) await activateOnPayment(tx, paid);
  return paid;
}

/** The invoice's tax, committed when it is paid — once (idempotent by reference). */
async function commitInvoiceTax(tx: Transaction, invoice: InvoiceRow, now: Date): Promise<void> {
  if (invoice.taxCalculationId) {
    await commitTaxTransaction(tx, {
      calculationPublicId: invoice.taxCalculationId,
      reference: invoice.publicId,
      rail: 'orbit',
      committedAt: now,
    });
    // Notes that reduced it while it was open are reversals of what was just committed.
    await reversePrePaymentNotes(tx, invoice, now);
  }
  // Proration credits reverse the tax of the line they credit (ADR 0013).
  const lines = await listLines(tx, invoice.id);
  const credits = lines.filter((line) => line.creditsLineId !== null && line.taxAmounts.length > 0);
  if (credits.length === 0) return;
  const credited = await findLinesByIds(
    tx,
    credits.map((line) => line.creditsLineId as string),
  );
  for (const credit of credits) {
    const original = credited.find((line) => line.id === credit.creditsLineId);
    if (!original) continue;
    const originalInvoice = await findInvoiceById(tx, original.invoiceId);
    if (!originalInvoice?.taxCalculationId) continue;
    const [transaction] = await tx
      .select({ id: taxTransactions.id })
      .from(taxTransactions)
      .where(
        and(
          eq(taxTransactions.merchantId, invoice.merchantId),
          eq(taxTransactions.reference, originalInvoice.publicId),
          isNull(taxTransactions.reversalOfId),
        ),
      );
    if (!transaction) continue;
    const net = BigInt(credit.amount) - BigInt(credit.discountAmount);
    const exclusive = credit.taxAmounts
      .filter((tax) => !tax.inclusive)
      .reduce((sum, tax) => sum + BigInt(tax.amount), 0n);
    const gross = -(net + exclusive);
    if (gross <= 0n) continue;
    await reverseTaxTransaction(tx, {
      originalId: transaction.id,
      reference: `${invoice.publicId}:${credit.publicId}`,
      reversedAt: now,
      target: (reversed, total) => (reversed + gross < total ? reversed + gross : total),
    });
  }
}

/** A subscription waiting on this invoice — incomplete, past due, unpaid — is active again. */
async function activateOnPayment(tx: Transaction, invoice: InvoiceRow): Promise<void> {
  if (!invoice.subscriptionId) return;
  const subscription = await lockSubscription(tx, invoice.subscriptionId);
  if (!subscription) return;
  if (subscription.latestInvoiceId !== invoice.id) return;
  if (!['incomplete', 'past_due', 'unpaid'].includes(subscription.status)) return;
  await transitionSubscription(tx, subscription, 'active', {
    nextActionAt: subscription.cancelAt ?? subscription.currentPeriodEnd,
  });
}

/** `void` an open or uncollectible invoice, giving back any balance it applied. */
export async function voidInvoiceInTx(
  tx: Transaction,
  invoice: InvoiceRow,
  now: Date,
): Promise<InvoiceRow> {
  if (invoice.status !== 'open' && invoice.status !== 'uncollectible') {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      `this invoice is ${invoice.status}; only an open or uncollectible invoice can be voided`,
    );
  }
  if (BigInt(invoice.amountPaid) > 0n) {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      'part of this invoice was paid; issue a credit note instead of voiding it',
    );
  }
  // Whatever balance the finalize consumed (or added) goes back.
  const given = BigInt(invoice.endingBalance ?? '0') - BigInt(invoice.startingBalance);
  if (given !== 0n) {
    const written = await recordBalanceTransaction(tx, {
      publicId: newId('cbtxn'),
      merchantId: invoice.merchantId,
      customerId: invoice.customerId,
      type: 'unapplied_from_invoice',
      amount: -given,
      currency: invoice.currency,
      invoiceId: invoice.id,
    });
    if (typeof written === 'string') throw new Error(`balance refused the void: ${written}`);
  }
  return transitionInvoice(tx, invoice, 'void', {
    voidedAt: now,
    nextPaymentAttempt: null,
    nextActionAt: null,
  });
}

export async function markUncollectibleInTx(
  tx: Transaction,
  invoice: InvoiceRow,
  now: Date,
): Promise<InvoiceRow> {
  if (invoice.status !== 'open') {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      `this invoice is ${invoice.status}; only an open invoice can be marked uncollectible`,
    );
  }
  return transitionInvoice(tx, invoice, 'uncollectible', {
    markedUncollectibleAt: now,
    nextPaymentAttempt: null,
    nextActionAt: null,
  });
}

/** Delete a draft (Stripe's `DELETE /v1/invoices/:id`): its pending items return to pending. */
export async function deleteDraftInTx(tx: Transaction, invoice: InvoiceRow): Promise<void> {
  if (invoice.status !== 'draft') {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      'only a draft can be deleted; void a finalized invoice',
    );
  }
  if (invoice.subscriptionId) {
    const subscription = await lockSubscription(tx, invoice.subscriptionId);
    if (subscription?.latestInvoiceId === invoice.id) {
      throw new BillingEngineError(
        'invoice_unexpected_state',
        "this draft is its subscription's latest invoice; void it once finalized instead",
      );
    }
  }
  const dto = await renderInvoice(tx, invoice);
  if (!(await deleteDraftInvoice(tx, invoice.id))) {
    throw new BillingEngineError('invoice_unexpected_state', 'only a draft can be deleted');
  }
  await recordBillingEvent(tx, invoice.merchantId, 'invoice.deleted', dto);
}

export function isPayable(status: InvoiceStatus): boolean {
  return status === 'open' || status === 'uncollectible';
}

function serializationConflict(error: unknown): boolean {
  for (
    let current = error, depth = 0;
    current && typeof current === 'object' && depth < 5;
    depth++
  ) {
    if ('code' in current && current.code === '40001') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
