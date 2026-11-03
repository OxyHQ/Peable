/**
 * Credit notes (ADR 0018 §3): giving back part or all of a finalized invoice.
 *
 * - On an OPEN invoice (`pre_payment`) it reduces what the invoice asks for;
 *   one that brings the amount remaining to zero leaves the invoice `paid`.
 * - On a PAID invoice (`post_payment`) the total is distributed: refunded
 *   through the invoice's payment (card only — the gateway never holds
 *   FairCoin), credited to the customer balance, or recorded as returned
 *   outside Orbit.
 *
 * Tax follows ADR 0013: a credit note is a REVERSAL of the invoice's tax
 * transaction, netted into the same report rows, never a deletion — written
 * when the note is issued against a paid invoice, or when an invoice carrying
 * pre-payment notes is paid. A voided note reinstates what it reversed.
 */
import type { CreditNote, CreditNoteReason } from '@peable.to/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import {
  findCreditNoteForMerchant,
  insertCreditNote,
  listCreditNoteLines,
  listInvoiceCreditNotes,
  lockCreditNote,
  setCreditNoteRefund,
  voidCreditNoteRow,
  type CreditNoteLineRow,
  type CreditNoteRow,
} from '../../db/billingEngine/creditNoteRepository';
import { recordBalanceTransaction } from '../../db/billingEngine/balanceRepository';
import {
  findInvoiceForMerchant,
  listLines,
  lockInvoice,
  type InvoiceLineRow,
  type InvoiceRow,
} from '../../db/billingEngine/invoiceRepository';
import { findIntentById } from '../../db/payments/paymentIntentRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { taxTransactions } from '../../db/schema';
import { type DatabaseOrTransaction, getDb, type Transaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { toUnix, toUnixOrNull } from '../../lib/time';
import { createRefund } from '../refunds/refundService';
import { reverseTaxTransaction } from '../tax/taxService';
import { kickWebhookOutbox } from '../webhookOutbox';
import { BillingEngineError, invalid, missing } from './errors';
import { allocate } from './invoiceMath';
import { markInvoicePaid } from './invoiceEngine';
import { engineNow } from './runtime';
import { patchInvoice, recordBillingEvent } from './transitions';
import { railOf } from './collect';

export interface CreditNoteInput {
  readonly invoice: string;
  readonly lines?: readonly {
    type: 'invoice_line_item' | 'custom_line_item';
    invoiceLineItem?: string;
    amount?: string;
    quantity?: number;
    description?: string;
  }[];
  readonly amount?: string;
  readonly reason?: CreditNoteReason;
  readonly memo?: string;
  readonly refundAmount?: string;
  readonly creditAmount?: string;
  readonly outOfBandAmount?: string;
  readonly metadata: Record<string, string>;
}

interface PlannedLine {
  readonly type: 'invoice_line_item' | 'custom_line_item';
  readonly invoiceLineItemId: string | null;
  readonly description: string | null;
  readonly quantity: number | null;
  /** Before exclusive tax (tax-inclusive for an inclusive line). */
  readonly amount: bigint;
  readonly taxAmount: bigint;
  /** What it gives back: amount + exclusive tax. */
  readonly total: bigint;
}

interface Plan {
  readonly lines: PlannedLine[];
  readonly subtotal: bigint;
  readonly tax: bigint;
  readonly total: bigint;
  readonly type: 'pre_payment' | 'post_payment';
  readonly refund: bigint;
  readonly credit: bigint;
  readonly outOfBand: bigint;
}

function lineNet(line: InvoiceLineRow): bigint {
  return BigInt(line.amount) - BigInt(line.discountAmount);
}

function lineTax(line: InvoiceLineRow): { exclusive: bigint; inclusive: bigint } {
  let exclusive = 0n;
  let inclusive = 0n;
  for (const tax of line.taxAmounts) {
    if (tax.inclusive) inclusive += BigInt(tax.amount);
    else exclusive += BigInt(tax.amount);
  }
  return { exclusive, inclusive };
}

function scale(value: bigint, part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  return (2n * value * part + whole) / (2n * whole);
}

/** Credit `net` (before exclusive tax) of one invoice line. */
function creditOfLine(line: InvoiceLineRow, net: bigint, quantity: number | null): PlannedLine {
  const full = lineNet(line);
  const { exclusive, inclusive } = lineTax(line);
  const tax = scale(exclusive + inclusive, net, full);
  const exclusiveShare = scale(exclusive, net, full);
  return {
    type: 'invoice_line_item',
    invoiceLineItemId: line.id,
    description: line.description,
    quantity,
    amount: net,
    taxAmount: tax,
    total: net + exclusiveShare,
  };
}

async function plan(
  db: DatabaseOrTransaction,
  invoice: InvoiceRow,
  input: CreditNoteInput,
): Promise<Plan> {
  if (invoice.status !== 'open' && invoice.status !== 'paid') {
    throw new BillingEngineError(
      'invoice_unexpected_state',
      `a credit note needs an open or paid invoice; this one is ${invoice.status}`,
      'invoice',
    );
  }
  if ((input.lines === undefined) === (input.amount === undefined)) {
    throw invalid('pass lines or amount', input.lines ? 'amount' : 'lines');
  }
  const invoiceLines = (await listLines(db, invoice.id)).filter((line) => lineNet(line) > 0n);
  const previous = (await listInvoiceCreditNotes(db, invoice.id)).filter(
    (note) => note.status === 'issued',
  );
  const previousLines = await listCreditNoteLines(
    db,
    previous.map((note) => note.id),
  );
  const creditedOf = (lineId: string) =>
    previousLines
      .filter((line: CreditNoteLineRow) => line.invoiceLineItemId === lineId)
      .reduce((sum, line) => sum + BigInt(line.amount), 0n);
  const lines: PlannedLine[] = [];
  if (input.lines) {
    for (const [i, entry] of input.lines.entries()) {
      const param = `lines[${i}]`;
      if (entry.type === 'custom_line_item') {
        if (!entry.amount) throw invalid('a custom line needs an amount', `${param}[amount]`);
        const amount = BigInt(entry.amount);
        lines.push({
          type: 'custom_line_item',
          invoiceLineItemId: null,
          description: entry.description ?? null,
          quantity: entry.quantity ?? null,
          amount,
          taxAmount: 0n,
          total: amount,
        });
        continue;
      }
      const line = invoiceLines.find((candidate) => candidate.publicId === entry.invoiceLineItem);
      if (!line) {
        throw new BillingEngineError(
          'resource_missing',
          'no such line on this invoice',
          `${param}[invoice_line_item]`,
        );
      }
      const left = lineNet(line) - creditedOf(line.id);
      const net = entry.amount !== undefined ? BigInt(entry.amount) : left;
      if (net <= 0n || net > left) {
        throw new BillingEngineError(
          'credit_note_exceeds_invoice',
          `at most ${left} of this line can still be credited`,
          `${param}[amount]`,
        );
      }
      lines.push(creditOfLine(line, net, entry.quantity ?? null));
    }
  } else {
    // A whole amount, tax included, spread over the lines by their gross.
    const total = BigInt(input.amount as string);
    const gross = invoiceLines.map((line) => {
      const net = lineNet(line) - creditedOf(line.id);
      return net > 0n ? net + scale(lineTax(line).exclusive, net, lineNet(line)) : 0n;
    });
    const available = gross.reduce((a, b) => a + b, 0n);
    if (total <= 0n || total > available) {
      throw new BillingEngineError(
        'credit_note_exceeds_invoice',
        `at most ${available} of this invoice can still be credited`,
        'amount',
      );
    }
    const shares = allocate(total, gross);
    for (const [i, line] of invoiceLines.entries()) {
      const share = shares[i] ?? 0n;
      if (share === 0n) continue;
      const full = lineNet(line);
      const exclusive = lineTax(line).exclusive;
      // share = net + exclusive × net / full  ⇒  net = share × full / (full + exclusive)
      const net = scale(share, full, full + exclusive);
      lines.push({ ...creditOfLine(line, net, null), total: share });
    }
  }
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0n);
  const tax = lines.reduce((sum, line) => sum + line.taxAmount, 0n);
  const total = lines.reduce((sum, line) => sum + line.total, 0n);
  if (total <= 0n) throw invalid('a credit note credits something', 'lines');
  const alreadyCredited = previous.reduce((sum, note) => sum + BigInt(note.total), 0n);
  if (alreadyCredited + total > BigInt(invoice.total)) {
    throw new BillingEngineError(
      'credit_note_exceeds_invoice',
      "the credit notes would exceed the invoice's total",
      'lines',
    );
  }
  if (invoice.status === 'open') {
    const remaining =
      BigInt(invoice.amountDue) -
      BigInt(invoice.amountPaid) -
      BigInt(invoice.prePaymentCreditNotesAmount);
    if (total > remaining) {
      throw new BillingEngineError(
        'credit_note_exceeds_invoice',
        `at most ${remaining} remains due on this invoice`,
        'lines',
      );
    }
    for (const field of ['refundAmount', 'creditAmount', 'outOfBandAmount'] as const) {
      if (input[field] !== undefined && input[field] !== '0') {
        throw invalid(
          'an open invoice is credited by reducing what it asks for',
          field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        );
      }
    }
    return {
      lines,
      subtotal,
      tax,
      total,
      type: 'pre_payment',
      refund: 0n,
      credit: 0n,
      outOfBand: 0n,
    };
  }
  const faircoin = railOf(invoice.currency) === 'faircoin';
  const given = [input.refundAmount, input.creditAmount, input.outOfBandAmount].some(
    (v) => v !== undefined,
  );
  let refund = input.refundAmount !== undefined ? BigInt(input.refundAmount) : 0n;
  const credit =
    input.creditAmount !== undefined
      ? BigInt(input.creditAmount)
      : given
        ? 0n
        : faircoin || invoice.paymentIntentId === null
          ? total
          : 0n;
  const outOfBand = input.outOfBandAmount !== undefined ? BigInt(input.outOfBandAmount) : 0n;
  if (!given && !faircoin && invoice.paymentIntentId !== null) refund = total;
  if (refund > 0n && (faircoin || invoice.paymentIntentId === null)) {
    throw invalid(
      faircoin
        ? 'a FairCoin payment is refunded by the merchant from its own wallet; record it as out_of_band_amount'
        : 'this invoice was not paid through Orbit; credit the balance or record it out of band',
      'refund_amount',
    );
  }
  if (refund + credit + outOfBand !== total) {
    throw invalid(
      `refund_amount, credit_amount and out_of_band_amount must add up to the credit note's total (${total})`,
      'refund_amount',
    );
  }
  return { lines, subtotal, tax, total, type: 'post_payment', refund, credit, outOfBand };
}

function toCreditNoteDTO(row: CreditNoteRow, lines: readonly CreditNoteLineRow[]): CreditNote {
  return {
    id: row.publicId,
    object: 'credit_note',
    livemode: row.livemode,
    number: row.number,
    invoice: row.invoicePublicId,
    customer: row.customerPublicId,
    status: row.status,
    type: row.type,
    reason: row.reason,
    currency: row.currency,
    lines: {
      object: 'list',
      data: lines.map((line) => ({
        id: line.publicId,
        object: 'credit_note_line_item',
        type: line.type,
        invoice_line_item: line.invoiceLineItemPublicId,
        description: line.description,
        quantity: line.quantity,
        amount: line.amount,
        tax_amount: line.taxAmount,
      })),
      has_more: false,
      url: `/v1/credit_notes/${row.publicId}/lines`,
    },
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    refund_amount: row.refundAmount,
    credit_amount: row.creditAmount,
    out_of_band_amount: row.outOfBandAmount,
    refund: row.refundPublicId,
    customer_balance_transaction: row.balanceTransactionPublicId,
    memo: row.memo,
    metadata: row.metadata,
    voided_at: toUnixOrNull(row.voidedAt),
    created: toUnix(row.createdAt),
  };
}

export async function renderCreditNotes(
  db: DatabaseOrTransaction,
  rows: readonly CreditNoteRow[],
): Promise<CreditNote[]> {
  const lines = await listCreditNoteLines(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    toCreditNoteDTO(
      row,
      lines.filter((line) => line.creditNoteId === row.id),
    ),
  );
}

/** `GET /v1/credit_notes/preview`: the note `create` would issue, computed and not stored. */
export async function previewCreditNote(
  merchant: MerchantRow,
  input: CreditNoteInput,
): Promise<CreditNote> {
  const db = getDb();
  const invoice = await findInvoiceForMerchant(db, input.invoice, merchant.id);
  if (!invoice)
    throw new BillingEngineError(
      'resource_missing',
      `no such invoice: '${input.invoice}'`,
      'invoice',
    );
  const planned = await plan(db, invoice, input);
  const lineRows = await listLines(db, invoice.id);
  const now = await engineNow(db, invoice.testClockId);
  return {
    ...toCreditNoteDTO(
      {
        id: '',
        publicId: '',
        merchantId: merchant.id,
        livemode: invoice.livemode,
        invoiceId: invoice.id,
        invoicePublicId: invoice.publicId,
        customerId: invoice.customerId,
        customerPublicId: invoice.customerPublicId,
        number: '',
        status: 'issued',
        type: planned.type,
        reason: input.reason ?? null,
        currency: invoice.currency,
        subtotal: planned.subtotal.toString(),
        tax: planned.tax.toString(),
        total: planned.total.toString(),
        refundAmount: planned.refund.toString(),
        creditAmount: planned.credit.toString(),
        outOfBandAmount: planned.outOfBand.toString(),
        refundId: null,
        refundPublicId: null,
        balanceTransactionPublicId: null,
        memo: input.memo ?? null,
        metadata: input.metadata,
        voidedAt: null,
        createdAt: now,
      },
      planned.lines.map((line, i) => ({
        id: '',
        publicId: `preview_${i}`,
        creditNoteId: '',
        type: line.type,
        invoiceLineItemId: line.invoiceLineItemId,
        invoiceLineItemPublicId:
          lineRows.find((row) => row.id === line.invoiceLineItemId)?.publicId ?? null,
        description: line.description,
        quantity: line.quantity,
        amount: line.amount.toString(),
        taxAmount: line.taxAmount.toString(),
      })),
    ),
  };
}

/** The invoice's committed tax transaction (the original, not a reversal), if any. */
async function invoiceTaxTransaction(
  tx: DatabaseOrTransaction,
  invoice: InvoiceRow,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: taxTransactions.id })
    .from(taxTransactions)
    .where(
      and(
        eq(taxTransactions.merchantId, invoice.merchantId),
        eq(taxTransactions.reference, invoice.publicId),
        isNull(taxTransactions.reversalOfId),
      ),
    );
  return row?.id ?? null;
}

/** Reverse (or, negative, reinstate) `gross` of the invoice's committed tax under `reference`. */
export async function reverseInvoiceTax(
  tx: Transaction,
  invoice: InvoiceRow,
  reference: string,
  gross: bigint,
  at: Date,
): Promise<void> {
  const original = await invoiceTaxTransaction(tx, invoice);
  if (!original || gross === 0n) return;
  await reverseTaxTransaction(tx, {
    originalId: original,
    reference,
    reversedAt: at,
    target: (reversed, total) => Math.max(0, Math.min(total, reversed + Number(gross))),
  });
}

export async function createCreditNote(
  merchant: MerchantRow,
  input: CreditNoteInput,
): Promise<CreditNoteRow> {
  const db = getDb();
  const found = await findInvoiceForMerchant(db, input.invoice, merchant.id);
  if (!found)
    throw new BillingEngineError(
      'resource_missing',
      `no such invoice: '${input.invoice}'`,
      'invoice',
    );
  const note = await db.transaction(async (tx) => {
    const invoice = await lockInvoice(tx, found.id);
    if (!invoice) throw missing('invoice');
    const planned = await plan(tx, invoice, input);
    const now = await engineNow(tx, invoice.testClockId);
    const sequence = (await listInvoiceCreditNotes(tx, invoice.id)).length + 1;
    const row = await insertCreditNote(
      tx,
      {
        publicId: newId('cn'),
        merchantId: merchant.id,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        number: `${invoice.number}-CN-${String(sequence).padStart(2, '0')}`,
        type: planned.type,
        reason: input.reason ?? null,
        currency: invoice.currency,
        subtotal: planned.subtotal.toString(),
        tax: planned.tax.toString(),
        total: planned.total.toString(),
        refundAmount: planned.refund.toString(),
        creditAmount: planned.credit.toString(),
        outOfBandAmount: planned.outOfBand.toString(),
        memo: input.memo ?? null,
        metadata: input.metadata,
      },
      planned.lines.map((line) => ({
        type: line.type,
        invoiceLineItemId: line.invoiceLineItemId,
        description: line.description,
        quantity: line.quantity,
        amount: line.amount.toString(),
        taxAmount: line.taxAmount.toString(),
      })),
    );
    if (planned.type === 'pre_payment') {
      const credited = BigInt(invoice.prePaymentCreditNotesAmount) + planned.total;
      let after = await patchInvoice(tx, invoice, {
        prePaymentCreditNotesAmount: credited.toString(),
      });
      const remaining = BigInt(after.amountDue) - BigInt(after.amountPaid) - credited;
      if (remaining <= 0n) after = await markInvoicePaid(tx, after, now, { amountPaid: 0n });
    } else {
      await patchInvoice(tx, invoice, {
        postPaymentCreditNotesAmount: (
          BigInt(invoice.postPaymentCreditNotesAmount) + planned.total
        ).toString(),
      });
      if (planned.credit > 0n) {
        const written = await recordBalanceTransaction(tx, {
          publicId: newId('cbtxn'),
          merchantId: merchant.id,
          customerId: invoice.customerId,
          type: 'credit_note',
          amount: -planned.credit,
          currency: invoice.currency,
          invoiceId: invoice.id,
          creditNoteId: row.id,
        });
        if (typeof written === 'string')
          throw new Error(`balance refused the credit note: ${written}`);
      }
      await reverseInvoiceTax(tx, invoice, row.publicId, planned.total, now);
    }
    const [dto] = await renderCreditNotes(tx, [row]);
    if (dto) await recordBillingEvent(tx, merchant.id, 'credit_note.created', dto);
    return row;
  });
  kickWebhookOutbox();
  if (BigInt(note.refundAmount) > 0n) {
    const invoice = await findInvoiceForMerchant(db, input.invoice, merchant.id);
    const intent = invoice?.paymentIntentId
      ? await findIntentById(db, invoice.paymentIntentId)
      : null;
    if (!intent) throw new Error('a refunded credit note without its payment');
    try {
      const { refund } = await createRefund({
        merchantId: merchant.id,
        intent,
        externalRef: note.publicId,
        amount: note.refundAmount,
      });
      await setCreditNoteRefund(db, note.id, refund.id);
    } catch (error) {
      // The money did not move: the note is voided so nothing claims it did.
      await voidCreditNote(merchant, note.publicId, { allowRefunded: true });
      throw error;
    }
  }
  return (await findCreditNoteForMerchant(db, note.publicId, merchant.id)) ?? note;
}

/**
 * `POST /v1/credit_notes/:id/void`. Reinstates what the note took off: the
 * amount due of an open invoice, a balance credit, the tax it reversed. A
 * note whose refund was made cannot be voided — the money already went back.
 */
export async function voidCreditNote(
  merchant: MerchantRow,
  publicId: string,
  options: { allowRefunded?: boolean } = {},
): Promise<CreditNoteRow> {
  const db = getDb();
  const found = await findCreditNoteForMerchant(db, publicId, merchant.id);
  if (!found) throw missing('credit note');
  const voided = await db.transaction(async (tx) => {
    const invoice = await lockInvoice(tx, found.invoiceId);
    const note = await lockCreditNote(tx, found.id);
    if (!invoice || !note) throw missing('credit note');
    if (note.status === 'void')
      throw new BillingEngineError('invoice_unexpected_state', 'this credit note is already void');
    if (note.refundId !== null && !options.allowRefunded) {
      throw new BillingEngineError(
        'invoice_unexpected_state',
        'this credit note refunded a payment and cannot be voided',
      );
    }
    const now = await engineNow(tx, invoice.testClockId);
    if (note.type === 'pre_payment') {
      if (invoice.status !== 'open') {
        throw new BillingEngineError(
          'invoice_unexpected_state',
          'the invoice is no longer open; this note can no longer be voided',
        );
      }
      await patchInvoice(tx, invoice, {
        prePaymentCreditNotesAmount: (
          BigInt(invoice.prePaymentCreditNotesAmount) - BigInt(note.total)
        ).toString(),
      });
    } else {
      await patchInvoice(tx, invoice, {
        postPaymentCreditNotesAmount: (
          BigInt(invoice.postPaymentCreditNotesAmount) - BigInt(note.total)
        ).toString(),
      });
      if (BigInt(note.creditAmount) > 0n) {
        const written = await recordBalanceTransaction(tx, {
          publicId: newId('cbtxn'),
          merchantId: merchant.id,
          customerId: note.customerId,
          type: 'credit_note',
          amount: BigInt(note.creditAmount),
          currency: note.currency,
          invoiceId: invoice.id,
          creditNoteId: note.id,
          description: `Credit note ${note.number} voided`,
        });
        if (typeof written === 'string') throw new Error(`balance refused the void: ${written}`);
      }
      await reverseInvoiceTax(tx, invoice, `${note.publicId}:void`, -BigInt(note.total), now);
    }
    const row = await voidCreditNoteRow(tx, note.id, now);
    const [dto] = await renderCreditNotes(tx, [row]);
    if (dto) await recordBillingEvent(tx, merchant.id, 'credit_note.voided', dto);
    return row;
  });
  kickWebhookOutbox();
  return voided;
}

/** Pre-payment notes of an invoice being paid become reversals of its now-committed tax. */
export async function reversePrePaymentNotes(
  tx: Transaction,
  invoice: InvoiceRow,
  at: Date,
): Promise<void> {
  for (const note of await listInvoiceCreditNotes(tx, invoice.id)) {
    if (note.status !== 'issued' || note.type !== 'pre_payment') continue;
    await reverseInvoiceTax(tx, invoice, note.publicId, BigInt(note.total), at);
  }
}
