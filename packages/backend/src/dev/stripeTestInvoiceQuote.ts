export interface LocalInvoiceQuote {
  subtotalMinorUnits: number;
  taxMinorUnits: number;
  totalMinorUnits: number;
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
): LocalInvoiceQuote | undefined {
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
    return undefined;
  let tax = 0;
  for (const item of invoice.total_taxes) {
    if (!Number.isSafeInteger(item.amount) || item.amount < 0 || item.tax_behavior !== 'inclusive')
      return undefined;
    tax += item.amount;
  }
  if (!Number.isSafeInteger(tax) || net + tax !== invoice.total) return undefined;
  return {
    subtotalMinorUnits: net,
    taxMinorUnits: tax,
    totalMinorUnits: invoice.total,
    inclusive: true,
  };
}
