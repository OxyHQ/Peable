/**
 * The invoice PDF (ADR 0018 §5), rendered by the gateway with no dependency.
 *
 * ## Why hand-written
 *
 * An invoice is text on a page: a header, a table of lines, the totals. PDF
 * 1.4 with the standard Helvetica font (one of the 14 every reader ships, so
 * nothing is embedded) expresses that in a few hundred bytes of objects and a
 * cross-reference table. A PDF library would add tens of thousands of lines
 * of dependency — fonts, layout engines, image codecs — to the gateway's
 * runtime image for a document that needs none of them, and a headless
 * browser would add a process. The output is deterministic for a given
 * invoice (no timestamps inside), which also makes it testable byte-for-byte.
 *
 * Text is WinAnsi (Latin-1): a character outside it is written as `?` rather
 * than producing a file some readers refuse.
 */
import { type CurrencyCode, decimalsFor } from '@peable.to/shared-types';

/** A signed base-unit amount as `12.34 EUR`. */
export function formatAmount(amount: string, currency: CurrencyCode): string {
  const negative = amount.startsWith('-');
  const digits = negative ? amount.slice(1) : amount;
  const decimals = decimalsFor(currency);
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals > 0 ? `.${padded.slice(padded.length - decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction} ${currency}`;
}

function latin1(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    out += code >= 32 && code <= 255 && code !== 127 ? char : '?';
  }
  return out;
}

function escapePdfText(text: string): string {
  return latin1(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export interface PdfInvoice {
  readonly merchantName: string;
  readonly number: string;
  readonly status: string;
  readonly currency: CurrencyCode;
  readonly issued: string;
  readonly due: string | null;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly lines: readonly { description: string; quantity: string; amount: string }[];
  readonly subtotal: string;
  readonly discount: string;
  readonly tax: string;
  readonly total: string;
  readonly amountPaid: string;
  readonly amountDue: string;
  readonly footer: string | null;
}

/** Render one invoice as a single-page (or more) PDF document. */
export function renderInvoicePdf(invoice: PdfInvoice): Uint8Array {
  const pages: string[][] = [[]];
  let y = 800;
  const page = () => pages[pages.length - 1] as string[];
  const text = (x: number, size: number, value: string, bold = false) => {
    page().push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${escapePdfText(value)}) Tj ET`,
    );
  };
  const right = (x: number, size: number, value: string, bold = false) => {
    // Helvetica's average advance is ~0.5em; right-align approximately.
    text(Math.max(40, x - latin1(value).length * size * 0.5), size, value, bold);
  };
  const line = () => {
    page().push(`0.8 G 40 ${y + 4} m 555 ${y + 4} l S 0 G`);
  };
  const down = (by: number) => {
    y -= by;
    if (y < 60) {
      pages.push([]);
      y = 800;
    }
  };

  text(40, 20, invoice.merchantName, true);
  right(555, 20, 'INVOICE', true);
  down(28);
  text(40, 10, `Invoice number: ${invoice.number}`);
  right(555, 10, `Status: ${invoice.status}`);
  down(14);
  text(40, 10, `Date of issue: ${invoice.issued}`);
  if (invoice.due) right(555, 10, `Due: ${invoice.due}`);
  down(24);
  text(40, 10, 'Bill to', true);
  down(14);
  if (invoice.customerName) {
    text(40, 10, invoice.customerName);
    down(14);
  }
  if (invoice.customerEmail) {
    text(40, 10, invoice.customerEmail);
    down(14);
  }
  down(16);
  text(40, 10, 'Description', true);
  right(430, 10, 'Qty', true);
  right(555, 10, 'Amount', true);
  down(6);
  line();
  down(14);
  for (const item of invoice.lines) {
    text(40, 10, item.description.slice(0, 70));
    right(430, 10, item.quantity);
    right(555, 10, item.amount);
    down(16);
  }
  line();
  down(16);
  const total = (label: string, value: string, bold = false) => {
    right(430, 10, label, bold);
    right(555, 10, value, bold);
    down(15);
  };
  total('Subtotal', invoice.subtotal);
  if (invoice.discount !== formatAmount('0', invoice.currency)) total('Discount', invoice.discount);
  total('Tax', invoice.tax);
  total('Total', invoice.total, true);
  total('Amount paid', invoice.amountPaid);
  total('Amount due', invoice.amountDue, true);
  if (invoice.footer) {
    down(20);
    text(40, 9, invoice.footer);
  }

  // Objects: 1 catalog, 2 pages, 3/4 fonts, then (page, content) per page.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((content, i) => {
    const pageId = 5 + i * 2;
    const stream = content.join('\n');
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}
