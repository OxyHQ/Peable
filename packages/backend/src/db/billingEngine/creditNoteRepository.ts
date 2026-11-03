import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type {
  CreditNoteReason,
  CreditNoteStatus,
  CreditNoteType,
  CurrencyCode,
} from '@peable.to/shared-types';
import { creditNoteLines, creditNotes } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { newId } from '../../lib/ids';
import { nowMs, publicIdOf, requiredPublicIdOf } from './columns';

/** Reads and writes for credit notes and their lines (ADR 0018 §3). Issued, voided — never deleted. */

export interface CreditNoteRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly invoiceId: string;
  readonly invoicePublicId: string;
  readonly customerId: string;
  readonly customerPublicId: string;
  readonly number: string;
  readonly status: CreditNoteStatus;
  readonly type: CreditNoteType;
  readonly reason: CreditNoteReason | null;
  readonly currency: CurrencyCode;
  readonly subtotal: string;
  readonly tax: string;
  readonly total: string;
  readonly refundAmount: string;
  readonly creditAmount: string;
  readonly outOfBandAmount: string;
  readonly refundId: string | null;
  readonly refundPublicId: string | null;
  readonly balanceTransactionPublicId: string | null;
  readonly memo: string | null;
  readonly metadata: Record<string, string>;
  readonly voidedAt: Date | null;
  readonly createdAt: Date;
}

const C = 'credit_notes';
const COLUMNS = {
  id: creditNotes.id,
  publicId: creditNotes.publicId,
  merchantId: creditNotes.merchantId,
  livemode: merchantLivemodeOf(creditNotes.merchantId),
  invoiceId: creditNotes.invoiceId,
  invoicePublicId: requiredPublicIdOf('invoices', C, 'invoice_id'),
  customerId: creditNotes.customerId,
  customerPublicId: requiredPublicIdOf('customers', C, 'customer_id'),
  number: creditNotes.number,
  status: creditNotes.status,
  type: creditNotes.type,
  reason: creditNotes.reason,
  currency: creditNotes.currency,
  subtotal: creditNotes.subtotal,
  tax: creditNotes.tax,
  total: creditNotes.total,
  refundAmount: creditNotes.refundAmount,
  creditAmount: creditNotes.creditAmount,
  outOfBandAmount: creditNotes.outOfBandAmount,
  refundId: creditNotes.refundId,
  refundPublicId: publicIdOf('refunds', C, 'refund_id'),
  balanceTransactionPublicId: sql<string | null>`(${sql.raw(
    `select b.public_id from customer_balance_transactions b where b.credit_note_id = "credit_notes"."id" order by b.id limit 1`,
  )})`,
  memo: creditNotes.memo,
  metadata: creditNotes.metadata,
  voidedAt: creditNotes.voidedAt,
  createdAt: creditNotes.createdAt,
} as const;

const toRow = (row: Record<string, unknown>) => row as unknown as CreditNoteRow;

export interface CreditNoteLineRow {
  readonly id: string;
  readonly publicId: string;
  readonly creditNoteId: string;
  readonly type: 'invoice_line_item' | 'custom_line_item';
  readonly invoiceLineItemId: string | null;
  readonly invoiceLineItemPublicId: string | null;
  readonly description: string | null;
  readonly quantity: number | null;
  readonly amount: string;
  readonly taxAmount: string;
}

const LINE_COLUMNS = {
  id: creditNoteLines.id,
  publicId: creditNoteLines.publicId,
  creditNoteId: creditNoteLines.creditNoteId,
  type: creditNoteLines.type,
  invoiceLineItemId: creditNoteLines.invoiceLineItemId,
  invoiceLineItemPublicId: publicIdOf(
    'invoice_line_items',
    'credit_note_lines',
    'invoice_line_item_id',
  ),
  description: creditNoteLines.description,
  quantity: creditNoteLines.quantity,
  amount: creditNoteLines.amount,
  taxAmount: creditNoteLines.taxAmount,
} as const;

export async function insertCreditNote(
  tx: Transaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly invoiceId: string;
    readonly customerId: string;
    readonly number: string;
    readonly type: CreditNoteType;
    readonly reason: CreditNoteReason | null;
    readonly currency: CurrencyCode;
    readonly subtotal: string;
    readonly tax: string;
    readonly total: string;
    readonly refundAmount: string;
    readonly creditAmount: string;
    readonly outOfBandAmount: string;
    readonly memo: string | null;
    readonly metadata: Record<string, string>;
  },
  lines: readonly {
    readonly type: 'invoice_line_item' | 'custom_line_item';
    readonly invoiceLineItemId: string | null;
    readonly description: string | null;
    readonly quantity: number | null;
    readonly amount: string;
    readonly taxAmount: string;
  }[],
): Promise<CreditNoteRow> {
  const id = uuidv7();
  await tx.insert(creditNotes).values({ id, ...params });
  if (lines.length > 0) {
    await tx
      .insert(creditNoteLines)
      .values(
        lines.map((line) => ({ id: uuidv7(), publicId: newId('cnli'), creditNoteId: id, ...line })),
      );
  }
  const row = await findCreditNoteById(tx, id);
  if (!row) throw new Error('credit note insert vanished');
  return row;
}

export async function findCreditNoteById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CreditNoteRow | null> {
  const [row] = await db.select(COLUMNS).from(creditNotes).where(eq(creditNotes.id, id));
  return row ? toRow(row) : null;
}

export async function findCreditNoteForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<CreditNoteRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(creditNotes)
    .where(and(eq(creditNotes.publicId, publicId), eq(creditNotes.merchantId, merchantId)));
  return row ? toRow(row) : null;
}

export async function lockCreditNote(tx: Transaction, id: string): Promise<CreditNoteRow | null> {
  const [row] = await tx
    .select(COLUMNS)
    .from(creditNotes)
    .where(eq(creditNotes.id, id))
    .for('update');
  return row ? toRow(row) : null;
}

/** Every credit note of an invoice, oldest first. */
export async function listInvoiceCreditNotes(
  db: DatabaseOrTransaction,
  invoiceId: string,
): Promise<CreditNoteRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(creditNotes)
    .where(eq(creditNotes.invoiceId, invoiceId))
    .orderBy(asc(creditNotes.id));
  return rows.map(toRow);
}

export async function listCreditNoteLines(
  db: DatabaseOrTransaction,
  creditNoteIds: readonly string[],
): Promise<CreditNoteLineRow[]> {
  if (creditNoteIds.length === 0) return [];
  const rows = await db
    .select(LINE_COLUMNS)
    .from(creditNoteLines)
    .where(inArray(creditNoteLines.creditNoteId, [...creditNoteIds]))
    .orderBy(asc(creditNoteLines.id));
  return rows as unknown as CreditNoteLineRow[];
}

export async function setCreditNoteRefund(
  tx: DatabaseOrTransaction,
  id: string,
  refundId: string,
): Promise<void> {
  await tx.update(creditNotes).set({ refundId, updatedAt: nowMs }).where(eq(creditNotes.id, id));
}

export async function voidCreditNoteRow(
  tx: Transaction,
  id: string,
  at: Date,
): Promise<CreditNoteRow> {
  await tx
    .update(creditNotes)
    .set({ status: 'void', voidedAt: at, updatedAt: nowMs })
    .where(and(eq(creditNotes.id, id), eq(creditNotes.status, 'issued')));
  const row = await findCreditNoteById(tx, id);
  if (!row) throw new Error('credit note vanished');
  return row;
}

export async function listCreditNotes(
  db: DatabaseOrTransaction,
  filters: {
    readonly merchantId: string;
    readonly page: KeysetPage;
    readonly invoiceId?: string | undefined;
    readonly customerId?: string | undefined;
  },
): Promise<{ data: CreditNoteRow[]; hasMore: boolean }> {
  const walk = keyset(creditNotes.id, creditNotes.createdAt, filters.page);
  const rows = await db
    .select(COLUMNS)
    .from(creditNotes)
    .where(
      and(
        eq(creditNotes.merchantId, filters.merchantId),
        filters.invoiceId ? eq(creditNotes.invoiceId, filters.invoiceId) : undefined,
        filters.customerId ? eq(creditNotes.customerId, filters.customerId) : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}
