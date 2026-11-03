/**
 * Rendering a customer email (Orbit Phase 3) — at SEND time, from the rows it
 * names, in the merchant's branding and the order's language.
 *
 * What a receipt carries is what a receipt needs and nothing more: the
 * merchant's name and branding, the amount, the lines, the receipt number,
 * the date and the rail. Never a client secret, an address, a card number, a
 * FairCoin address, metadata or any id beyond the payment's own `pi_…`.
 * Every interpolated string is HTML-escaped; colours are the validated
 * `#rrggbb` branding stores; the logo is an Oxy media URL.
 */
import {
  type CheckoutLocale,
  CHECKOUT_LOCALES,
  type CurrencyCode,
  decimalsFor,
} from '@peable.to/shared-types';
import { findBranding, findEmailSettings } from '../../db/merchants/brandingRepository';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import {
  findSessionById,
  findSessionByIntentId,
  listLineItems,
  type CheckoutLineItemRow,
} from '../../db/payments/checkoutSessionRepository';
import { findIntentById } from '../../db/payments/paymentIntentRepository';
import type { Database } from '../../db/postgres';
import { refunds } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { toCheckoutBranding } from '../../lib/serializeCheckout';
import type { OutboundEmail } from './mailer';
import type { OwedEmailRow } from './outbox';
import { findInvoiceById, listLines } from '../../db/billingEngine/invoiceRepository';
import { hostedInvoiceUrl } from '../../lib/serializeBilling';

type Strings = {
  receiptSubject: (merchant: string) => string;
  refundSubject: (merchant: string) => string;
  confirmationSubject: (merchant: string) => string;
  receipt: string;
  refund: string;
  confirmation: string;
  amountPaid: string;
  amountRefunded: string;
  total: string;
  subtotal: string;
  discount: string;
  tax: string;
  date: string;
  paidWith: string;
  card: string;
  faircoin: string;
  confirming: string;
  questions: string;
  receiptNumber: string;
  invoiceSubject: (merchant: string, number: string) => string;
  paymentFailedSubject: (merchant: string) => string;
  invoice: string;
  paymentFailed: string;
  invoiceNumber: string;
  amountDue: string;
  dueDate: string;
  nextAttempt: string;
  payInvoice: string;
  paymentFailedNote: string;
};

const STRINGS: Record<CheckoutLocale, Strings> = {
  en: {
    receiptSubject: (m) => `Your receipt from ${m}`,
    refundSubject: (m) => `Your refund from ${m}`,
    confirmationSubject: (m) => `Your order with ${m} is confirmed`,
    receipt: 'Receipt',
    refund: 'Refund',
    confirmation: 'Order confirmed',
    amountPaid: 'Amount paid',
    amountRefunded: 'Amount refunded',
    total: 'Total',
    subtotal: 'Subtotal',
    discount: 'Discount',
    tax: 'Tax',
    date: 'Date',
    paidWith: 'Paid with',
    card: 'Card',
    faircoin: 'FairCoin',
    confirming: 'Your payment is being confirmed.',
    questions: 'Questions? Reply to this email.',
    receiptNumber: 'Receipt number',
    invoiceSubject: (m, n) => `Invoice ${n} from ${m}`,
    paymentFailedSubject: (m) => `Your payment to ${m} failed`,
    invoice: 'Invoice',
    paymentFailed: 'Payment failed',
    invoiceNumber: 'Invoice number',
    amountDue: 'Amount due',
    dueDate: 'Due date',
    nextAttempt: 'Next attempt',
    payInvoice: 'View and pay the invoice',
    paymentFailedNote:
      'We could not collect this payment. Update your payment method or pay the invoice now.',
  },
  es: {
    receiptSubject: (m) => `Tu recibo de ${m}`,
    refundSubject: (m) => `Tu reembolso de ${m}`,
    confirmationSubject: (m) => `Tu pedido con ${m} está confirmado`,
    receipt: 'Recibo',
    refund: 'Reembolso',
    confirmation: 'Pedido confirmado',
    amountPaid: 'Importe pagado',
    amountRefunded: 'Importe reembolsado',
    total: 'Total',
    subtotal: 'Subtotal',
    discount: 'Descuento',
    tax: 'Impuestos',
    date: 'Fecha',
    paidWith: 'Pagado con',
    card: 'Tarjeta',
    faircoin: 'FairCoin',
    confirming: 'Tu pago se está confirmando.',
    questions: '¿Dudas? Responde a este correo.',
    receiptNumber: 'Número de recibo',
    invoiceSubject: (m, n) => `Factura ${n} de ${m}`,
    paymentFailedSubject: (m) => `Tu pago a ${m} no se ha podido cobrar`,
    invoice: 'Factura',
    paymentFailed: 'Pago fallido',
    invoiceNumber: 'Número de factura',
    amountDue: 'Importe pendiente',
    dueDate: 'Vencimiento',
    nextAttempt: 'Próximo intento',
    payInvoice: 'Ver y pagar la factura',
    paymentFailedNote:
      'No hemos podido cobrar este pago. Actualiza tu método de pago o paga la factura ahora.',
  },
  fr: {
    receiptSubject: (m) => `Votre reçu de ${m}`,
    refundSubject: (m) => `Votre remboursement de ${m}`,
    confirmationSubject: (m) => `Votre commande chez ${m} est confirmée`,
    receipt: 'Reçu',
    refund: 'Remboursement',
    confirmation: 'Commande confirmée',
    amountPaid: 'Montant payé',
    amountRefunded: 'Montant remboursé',
    total: 'Total',
    subtotal: 'Sous-total',
    discount: 'Remise',
    tax: 'Taxes',
    date: 'Date',
    paidWith: 'Payé avec',
    card: 'Carte',
    faircoin: 'FairCoin',
    confirming: 'Votre paiement est en cours de confirmation.',
    questions: 'Des questions ? Répondez à cet e-mail.',
    receiptNumber: 'Numéro de reçu',
    invoiceSubject: (m, n) => `Facture ${n} de ${m}`,
    paymentFailedSubject: (m) => `Votre paiement à ${m} a échoué`,
    invoice: 'Facture',
    paymentFailed: 'Paiement échoué',
    invoiceNumber: 'Numéro de facture',
    amountDue: 'Montant dû',
    dueDate: 'Échéance',
    nextAttempt: 'Prochaine tentative',
    payInvoice: 'Voir et payer la facture',
    paymentFailedNote:
      "Nous n'avons pas pu encaisser ce paiement. Mettez à jour votre moyen de paiement ou payez la facture maintenant.",
  },
  de: {
    receiptSubject: (m) => `Ihre Quittung von ${m}`,
    refundSubject: (m) => `Ihre Erstattung von ${m}`,
    confirmationSubject: (m) => `Ihre Bestellung bei ${m} ist bestätigt`,
    receipt: 'Quittung',
    refund: 'Erstattung',
    confirmation: 'Bestellung bestätigt',
    amountPaid: 'Bezahlter Betrag',
    amountRefunded: 'Erstatteter Betrag',
    total: 'Gesamt',
    subtotal: 'Zwischensumme',
    discount: 'Rabatt',
    tax: 'Steuern',
    date: 'Datum',
    paidWith: 'Bezahlt mit',
    card: 'Karte',
    faircoin: 'FairCoin',
    confirming: 'Ihre Zahlung wird bestätigt.',
    questions: 'Fragen? Antworten Sie auf diese E-Mail.',
    receiptNumber: 'Quittungsnummer',
    invoiceSubject: (m, n) => `Rechnung ${n} von ${m}`,
    paymentFailedSubject: (m) => `Ihre Zahlung an ${m} ist fehlgeschlagen`,
    invoice: 'Rechnung',
    paymentFailed: 'Zahlung fehlgeschlagen',
    invoiceNumber: 'Rechnungsnummer',
    amountDue: 'Fälliger Betrag',
    dueDate: 'Fällig am',
    nextAttempt: 'Nächster Versuch',
    payInvoice: 'Rechnung ansehen und bezahlen',
    paymentFailedNote:
      'Wir konnten diese Zahlung nicht einziehen. Aktualisieren Sie Ihre Zahlungsmethode oder bezahlen Sie die Rechnung jetzt.',
  },
  it: {
    receiptSubject: (m) => `La tua ricevuta da ${m}`,
    refundSubject: (m) => `Il tuo rimborso da ${m}`,
    confirmationSubject: (m) => `Il tuo ordine con ${m} è confermato`,
    receipt: 'Ricevuta',
    refund: 'Rimborso',
    confirmation: 'Ordine confermato',
    amountPaid: 'Importo pagato',
    amountRefunded: 'Importo rimborsato',
    total: 'Totale',
    subtotal: 'Subtotale',
    discount: 'Sconto',
    tax: 'Imposte',
    date: 'Data',
    paidWith: 'Pagato con',
    card: 'Carta',
    faircoin: 'FairCoin',
    confirming: 'Il tuo pagamento è in fase di conferma.',
    questions: 'Domande? Rispondi a questa email.',
    receiptNumber: 'Numero di ricevuta',
    invoiceSubject: (m, n) => `Fattura ${n} da ${m}`,
    paymentFailedSubject: (m) => `Il tuo pagamento a ${m} non è riuscito`,
    invoice: 'Fattura',
    paymentFailed: 'Pagamento non riuscito',
    invoiceNumber: 'Numero fattura',
    amountDue: 'Importo dovuto',
    dueDate: 'Scadenza',
    nextAttempt: 'Prossimo tentativo',
    payInvoice: 'Visualizza e paga la fattura',
    paymentFailedNote:
      'Non siamo riusciti a incassare questo pagamento. Aggiorna il metodo di pagamento o paga ora la fattura.',
  },
  pt: {
    receiptSubject: (m) => `O seu recibo de ${m}`,
    refundSubject: (m) => `O seu reembolso de ${m}`,
    confirmationSubject: (m) => `A sua encomenda com ${m} está confirmada`,
    receipt: 'Recibo',
    refund: 'Reembolso',
    confirmation: 'Encomenda confirmada',
    amountPaid: 'Montante pago',
    amountRefunded: 'Montante reembolsado',
    total: 'Total',
    subtotal: 'Subtotal',
    discount: 'Desconto',
    tax: 'Impostos',
    date: 'Data',
    paidWith: 'Pago com',
    card: 'Cartão',
    faircoin: 'FairCoin',
    confirming: 'O seu pagamento está a ser confirmado.',
    questions: 'Dúvidas? Responda a este e-mail.',
    receiptNumber: 'Número do recibo',
    invoiceSubject: (m, n) => `Fatura ${n} de ${m}`,
    paymentFailedSubject: (m) => `O seu pagamento a ${m} falhou`,
    invoice: 'Fatura',
    paymentFailed: 'Pagamento falhado',
    invoiceNumber: 'Número da fatura',
    amountDue: 'Montante em dívida',
    dueDate: 'Vencimento',
    nextAttempt: 'Próxima tentativa',
    payInvoice: 'Ver e pagar a fatura',
    paymentFailedNote:
      'Não conseguimos cobrar este pagamento. Atualize o seu método de pagamento ou pague a fatura agora.',
  },
};

export function stringsFor(locale: string | null | undefined): Strings {
  return (CHECKOUT_LOCALES as readonly string[]).includes(locale ?? '')
    ? STRINGS[locale as CheckoutLocale]
    : STRINGS.en;
}

/** An amount as a payer reads it: `€12.50`, `12.5 FAIR`. Exact: no float touches the digits. */
export function formatAmount(amount: string, currency: CurrencyCode, locale: string): string {
  const decimals = decimalsFor(currency);
  const units = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = (units / scale).toString();
  const fraction = (units % scale).toString().padStart(decimals, '0');
  if (currency === 'FAIR') {
    const trimmed = fraction.replace(/0+$/, '');
    return `${whole}${trimmed ? `.${trimmed}` : ''} FAIR`;
  }
  const format = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  // Format the integer part through Intl for grouping and symbol, then put the
  // exact fraction back — `Number(amount)` would round a large amount.
  const parts = format.formatToParts(Number(whole));
  return parts.map((part) => (part.type === 'fraction' ? fraction : part.value)).join('');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Rendered {
  readonly subject: string;
  readonly heading: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: number;
    readonly amount: string;
  }[];
  readonly note: string | null;
  /** A call to action (an invoice's hosted page). */
  readonly action?: { readonly label: string; readonly url: string } | undefined;
}

function toEmail(
  row: OwedEmailRow,
  view: Rendered,
  brand: {
    name: string;
    logo: string | null;
    primary: string;
    replyTo: string | null;
    questions: string;
  },
): OutboundEmail {
  const headers = {
    'X-Peable-Email-Id': row.id,
    'X-Peable-Email-Kind': row.kind,
  };
  const text = [
    brand.name,
    view.heading,
    '',
    ...view.lines.map((line) => `${line.quantity} × ${line.description}  ${line.amount}`),
    ...(view.lines.length > 0 ? [''] : []),
    ...view.rows.map(([label, value]) => `${label}: ${value}`),
    ...(view.note ? ['', view.note] : []),
    ...(view.action ? ['', `${view.action.label}: ${view.action.url}`] : []),
    ...(brand.replyTo ? ['', brand.questions] : []),
  ].join('\n');
  const cell = 'padding:6px 0;font-size:14px;';
  const html = `<!doctype html><html><body style="margin:0;background:#f6f8fa;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0b1f33">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:8px;padding:24px">
<tr><td style="border-bottom:3px solid ${brand.primary};padding-bottom:12px">${
    brand.logo
      ? `<img src="${escapeHtml(brand.logo)}" alt="${escapeHtml(brand.name)}" height="32" style="height:32px">`
      : `<strong style="font-size:18px">${escapeHtml(brand.name)}</strong>`
  }</td></tr>
<tr><td style="padding-top:16px"><h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(view.heading)}</h1>
${
  view.lines.length > 0
    ? `<table role="presentation" width="100%">${view.lines
        .map(
          (line) =>
            `<tr><td style="${cell}">${line.quantity} × ${escapeHtml(line.description)}</td><td align="right" style="${cell}">${escapeHtml(line.amount)}</td></tr>`,
        )
        .join('')}</table><hr style="border:none;border-top:1px solid #e1e4e8">`
    : ''
}
<table role="presentation" width="100%">${view.rows
    .map(
      ([label, value]) =>
        `<tr><td style="${cell}color:#57606a">${escapeHtml(label)}</td><td align="right" style="${cell}">${escapeHtml(value)}</td></tr>`,
    )
    .join('')}</table>
${view.note ? `<p style="font-size:14px">${escapeHtml(view.note)}</p>` : ''}
${view.action ? `<p style="padding-top:8px"><a href="${escapeHtml(view.action.url)}" style="display:inline-block;background:${brand.primary};color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px">${escapeHtml(view.action.label)}</a></p>` : ''}
${brand.replyTo ? `<p style="font-size:12px;color:#57606a">${escapeHtml(brand.questions)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
  return { to: row.recipient, replyTo: brand.replyTo, subject: view.subject, text, html, headers };
}

function lineViews(lines: readonly CheckoutLineItemRow[], locale: string) {
  return lines
    .filter((line) => line.quantity > 0)
    .map((line) => ({
      description: line.description,
      quantity: line.quantity,
      amount: formatAmount(line.amountTotal, line.currency, locale),
    }));
}

/**
 * Render an owed email, or `null` when what it names is gone (it is then
 * marked failed — there is nothing true left to send).
 */
export async function renderOwedEmail(
  db: Database,
  row: OwedEmailRow,
): Promise<OutboundEmail | null> {
  const merchant = await findMerchantById(db, row.merchantId);
  if (!merchant) return null;
  const [brandingRow, settings] = await Promise.all([
    findBranding(db, merchant.id),
    findEmailSettings(db, merchant.id),
  ]);
  const branding = toCheckoutBranding(merchant, brandingRow);
  const name = merchant.displayName ?? 'Peable merchant';
  const intent = row.paymentIntentId ? await findIntentById(db, row.paymentIntentId) : null;
  const session = row.checkoutSessionId
    ? await findSessionById(db, row.checkoutSessionId)
    : intent
      ? await findSessionByIntentId(db, intent.id)
      : null;
  const locale = session?.locale ?? 'en';
  const t = stringsFor(locale);
  const lines = session ? await listLineItems(db, session.id) : [];
  const brand = {
    name,
    logo: branding.logo_url ?? branding.icon_url,
    primary: branding.primary_color,
    replyTo: settings.supportEmail,
    questions: t.questions,
  };
  const dateOf = (date: Date) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
  const railLabel = (rail: string) => (rail === 'faircoin' ? t.faircoin : t.card);

  switch (row.kind) {
    case 'payment_receipt': {
      if (!intent || !row.receiptNumber) return null;
      const money = (amount: string) => formatAmount(amount, intent.currency, locale);
      return toEmail(
        row,
        {
          subject: t.receiptSubject(name),
          heading: `${t.receipt} ${row.receiptNumber}`,
          lines: lineViews(lines, locale),
          rows: [
            ...(session && session.amountDiscount !== '0'
              ? ([[t.discount, `−${money(session.amountDiscount)}`]] as const)
              : []),
            ...(session && session.amountTax !== '0'
              ? ([[t.tax, money(session.amountTax)]] as const)
              : []),
            [
              t.amountPaid,
              money(intent.amountReceived !== '0' ? intent.amountReceived : intent.amount),
            ],
            [t.date, dateOf(intent.updatedAt)],
            [t.paidWith, railLabel(intent.rail)],
            [t.receiptNumber, row.receiptNumber],
          ],
          note: null,
        },
        brand,
      );
    }
    case 'refund_notice': {
      if (!intent || !row.refundId) return null;
      const [refund] = await db.select().from(refunds).where(eq(refunds.id, row.refundId));
      if (!refund) return null;
      return toEmail(
        row,
        {
          subject: t.refundSubject(name),
          heading: t.refund,
          lines: [],
          rows: [
            [
              t.amountRefunded,
              formatAmount(refund.amount, refund.currency as CurrencyCode, locale),
            ],
            [t.date, dateOf(refund.updatedAt)],
            [t.paidWith, railLabel(intent.rail)],
          ],
          note: null,
        },
        brand,
      );
    }
    case 'invoice':
    case 'invoice_payment_failed': {
      if (!row.invoiceId) return null;
      const invoice = await findInvoiceById(db, row.invoiceId);
      if (!invoice?.number || !invoice.hostedToken) return null;
      const money = (amount: string) => formatAmount(amount, invoice.currency, locale);
      const due =
        BigInt(invoice.amountDue) -
        BigInt(invoice.amountPaid) -
        BigInt(invoice.prePaymentCreditNotesAmount);
      const failed = row.kind === 'invoice_payment_failed';
      return toEmail(
        row,
        {
          subject: failed ? t.paymentFailedSubject(name) : t.invoiceSubject(name, invoice.number),
          heading: failed ? t.paymentFailed : `${t.invoice} ${invoice.number}`,
          lines: (await listLines(db, invoice.id)).map((line) => ({
            description: line.description ?? '',
            quantity: line.quantity ?? 1,
            amount: formatAmount(line.amount, line.currency, locale),
          })),
          rows: [
            [t.invoiceNumber, invoice.number],
            [t.amountDue, money((due > 0n ? due : 0n).toString())],
            ...(invoice.dueDate ? ([[t.dueDate, dateOf(invoice.dueDate)]] as const) : []),
            ...(failed && invoice.nextPaymentAttempt
              ? ([[t.nextAttempt, dateOf(invoice.nextPaymentAttempt)]] as const)
              : []),
          ],
          note: failed ? t.paymentFailedNote : null,
          action: { label: t.payInvoice, url: hostedInvoiceUrl(invoice.hostedToken) },
        },
        brand,
      );
    }
    case 'checkout_confirmation': {
      if (!session) return null;
      const money = (amount: string) => formatAmount(amount, session.currency, locale);
      return toEmail(
        row,
        {
          subject: t.confirmationSubject(name),
          heading: t.confirmation,
          lines: lineViews(lines, locale),
          rows: [
            ...(session.mode !== 'setup' ? ([[t.total, money(session.amount)]] as const) : []),
            [t.date, dateOf(session.completedAt ?? session.updatedAt)],
          ],
          note: session.paymentStatus === 'unpaid' ? t.confirming : null,
        },
        brand,
      );
    }
  }
}
