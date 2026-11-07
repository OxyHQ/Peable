/**
 * A quote as its PDF — the invoice's own renderer (`pdf.ts`), titled QUOTE,
 * dated by its expiry. A draft renders as a draft (no number): the document
 * is what the quote IS.
 */
import { findCustomerById } from '../../db/customers/customerRepository';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { listQuoteLines, type QuoteRow } from '../../db/billingEngine/quoteRepository';
import { getDb } from '../../db/postgres';
import { formatAmount, renderInvoicePdf } from './pdf';

const day = (date: Date) => date.toISOString().slice(0, 10);

export async function quotePdf(quote: QuoteRow): Promise<Uint8Array> {
  const db = getDb();
  const merchant = await findMerchantById(db, quote.merchantId);
  const customer = await findCustomerById(db, quote.customerId);
  const lines = await listQuoteLines(db, quote.id);
  const discount = quote.amountDiscount === '0' ? '0' : `-${quote.amountDiscount}`;
  return renderInvoicePdf({
    kind: { title: 'QUOTE', numberLabel: 'Quote number', dueLabel: 'Expires' },
    header: quote.header,
    merchantName: merchant?.displayName ?? 'Quote',
    number: quote.number ?? 'DRAFT',
    status: quote.status,
    currency: quote.currency,
    issued: day(quote.finalizedAt ?? quote.createdAt),
    due: day(quote.expiresAt),
    customerName: customer?.name ?? null,
    customerEmail: customer?.email ?? null,
    lines: lines.map((line) => ({
      description: line.description,
      quantity: String(line.quantity),
      amount: formatAmount(line.amountSubtotal, line.currency),
    })),
    subtotal: formatAmount(quote.amountSubtotal, quote.currency),
    discount: formatAmount(discount, quote.currency),
    tax:
      quote.amountTax === null
        ? 'calculated when finalized'
        : formatAmount(quote.amountTax, quote.currency),
    total: formatAmount(quote.amountTotal, quote.currency),
    amountPaid: null,
    amountDue: null,
    footer: [quote.description, quote.footer].filter((text) => text !== null).join(' — ') || null,
  });
}
