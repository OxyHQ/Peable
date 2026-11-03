interface InvoiceState {
  invoiceStatus: string | null;
  subscriptionStatus: string;
}
/** A paid race is truth, never a reason to cancel a now-active subscription. */
export async function voidUnpaidInitialInvoice(
  initial: InvoiceState,
  voidInvoice: () => Promise<unknown>,
  read: () => Promise<InvoiceState>,
): Promise<void> {
  if (initial.invoiceStatus !== 'open' || initial.subscriptionStatus !== 'incomplete') return;
  try {
    await voidInvoice();
  } catch {
    const current = await read();
    if (current.invoiceStatus !== 'paid' && current.invoiceStatus !== 'void')
      throw new Error('Invoice cancellation unresolved');
  }
}
