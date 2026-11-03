/**
 * An invoice as its PDF (`pdf.ts` renders; this gathers what it shows). A
 * draft renders as a draft (no number): the document is what the invoice IS.
 */
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { listLines, type InvoiceRow } from '../../db/billingEngine/invoiceRepository';
import { getDb } from '../../db/postgres';
import { formatAmount, renderInvoicePdf } from './pdf';

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/** A discount shown as what it takes off: `-500` for a 500 discount, `500` for a credit's. */
function negated(amount: string): string {
  if (amount === '0') return '0';
  return amount.startsWith('-') ? amount.slice(1) : `-${amount}`;
}

export async function invoicePdf(invoice: InvoiceRow): Promise<Uint8Array> {
  const db = getDb();
  const merchant = await findMerchantById(db, invoice.merchantId);
  const lines = await listLines(db, invoice.id);
  const remaining =
    invoice.status === 'paid' || invoice.status === 'void'
      ? 0n
      : BigInt(invoice.amountDue) -
        BigInt(invoice.amountPaid) -
        BigInt(invoice.prePaymentCreditNotesAmount);
  return renderInvoicePdf({
    merchantName: merchant?.displayName ?? 'Invoice',
    number: invoice.number ?? 'DRAFT',
    status: invoice.status,
    currency: invoice.currency,
    issued: day(invoice.finalizedAt ?? invoice.createdAt) ?? '',
    due: day(invoice.dueDate),
    customerName: invoice.customerName,
    customerEmail: invoice.customerEmail,
    lines: lines.map((line) => ({
      description: line.description ?? '',
      quantity: line.quantity === null ? '' : String(line.quantity),
      amount: formatAmount(line.amount, line.currency),
    })),
    subtotal: formatAmount(invoice.subtotal, invoice.currency),
    discount: formatAmount(negated(invoice.totalDiscount), invoice.currency),
    tax: formatAmount(invoice.tax ?? '0', invoice.currency),
    total: formatAmount(invoice.total, invoice.currency),
    amountPaid: formatAmount(invoice.amountPaid, invoice.currency),
    amountDue: formatAmount((remaining > 0n ? remaining : 0n).toString(), invoice.currency),
    footer: invoice.description,
  });
}
