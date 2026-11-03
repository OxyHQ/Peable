/** The first invoice's tax breakdown, base-unit strings in the invoice currency (ADR 0014). */
export interface LocalInvoiceQuote {
  amount_subtotal: string;
  amount_tax: string;
  amount_total: string;
  inclusive: boolean;
}
/** Provider-recorded invoice arithmetic, not a tax-registration or rate decision. */
export function localInvoiceQuote(
  invoice: {
    total: number;
    total_excluding_tax: number | null;
    total_taxes: readonly { amount: number; tax_behavior: string }[] | null;
  },
  priceTaxBehavior: string,
): LocalInvoiceQuote | null {
  const net = invoice.total_excluding_tax;
  if (
    priceTaxBehavior !== 'inclusive' ||
    net === null ||
    invoice.total_taxes === null ||
    !Number.isSafeInteger(net) ||
    net < 0 ||
    !Number.isSafeInteger(invoice.total) ||
    invoice.total < net
  )
    return null;
  let tax = 0;
  for (const item of invoice.total_taxes) {
    if (!Number.isSafeInteger(item.amount) || item.amount < 0 || item.tax_behavior !== 'inclusive')
      return null;
    tax += item.amount;
  }
  if (!Number.isSafeInteger(tax) || net + tax !== invoice.total) return null;
  return {
    amount_subtotal: String(net),
    amount_tax: String(tax),
    amount_total: String(invoice.total),
    inclusive: true,
  };
}
