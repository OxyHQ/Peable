/** A provider quote, not a client credit calculator or eligibility decision. */
export interface InstallmentQuote {
  id: string;
  currency: string;
  orderMinorUnits: number;
  dueTodayMinorUnits: number;
  totalMinorUnits: number;
  interestMinorUnits: number;
  feesMinorUnits: number;
  payments: readonly { id: string; dueOn: string; amountMinorUnits: number }[];
}
/** Structural consistency only; this cannot authenticate a provider or approve credit. */
export function validInstallmentQuote(quote: InstallmentQuote): boolean {
  const amounts = [
    quote.orderMinorUnits,
    quote.dueTodayMinorUnits,
    quote.totalMinorUnits,
    quote.interestMinorUnits,
    quote.feesMinorUnits,
    ...quote.payments.map((payment) => payment.amountMinorUnits),
  ];
  return (
    !!quote.id &&
    /^[A-Z]{3}$/.test(quote.currency) &&
    amounts.every((amount) => Number.isSafeInteger(amount) && amount >= 0) &&
    quote.payments.length > 0 &&
    quote.payments.length <= 36 &&
    new Set(quote.payments.map((payment) => payment.id)).size === quote.payments.length &&
    quote.payments.every(
      (payment) =>
        !!payment.id &&
        /^\d{4}-\d{2}-\d{2}$/.test(payment.dueOn) &&
        Number.isFinite(Date.parse(`${payment.dueOn}T00:00:00Z`)) &&
        new Date(`${payment.dueOn}T00:00:00Z`).toISOString().slice(0, 10) === payment.dueOn,
    ) &&
    quote.dueTodayMinorUnits <= quote.totalMinorUnits &&
    Number.isSafeInteger(quote.orderMinorUnits + quote.interestMinorUnits + quote.feesMinorUnits) &&
    Number.isSafeInteger(
      quote.payments.reduce((sum, payment) => sum + payment.amountMinorUnits, 0),
    ) &&
    quote.totalMinorUnits ===
      quote.orderMinorUnits + quote.interestMinorUnits + quote.feesMinorUnits &&
    quote.payments.reduce((sum, payment) => sum + payment.amountMinorUnits, 0) ===
      quote.totalMinorUnits
  );
}
