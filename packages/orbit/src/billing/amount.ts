import { formatAmount } from '../format/money';

const SIGNED = /^(0|-?[1-9][0-9]*)$/;

/**
 * A SIGNED base-unit amount (ADR 0018: a proration credit, a negative invoice
 * total, a customer balance) as `-5.00 EUR`, exactly — the sign is taken off,
 * the magnitude formatted by `formatAmount`, and the sign put back. Anything
 * the gateway would never send is shown as its raw text.
 */
export function formatSignedAmount(amount: string, currency: string): string {
  if (!SIGNED.test(amount)) return `${amount} (base units) ${currency}`;
  if (!amount.startsWith('-')) return formatAmount(amount, currency);
  return `-${formatAmount(amount.slice(1), currency)}`;
}

/**
 * A customer balance as a merchant reads it: Stripe's convention is negative
 * = credit the customer holds, so the words say which way it goes.
 */
export function describeBalance(
  balance: string,
  currency: string | null,
): { kind: 'none' | 'credit' | 'owed'; amount: string | null } {
  if (balance === '0' || currency === null || !SIGNED.test(balance)) {
    return { kind: 'none', amount: null };
  }
  if (balance.startsWith('-')) {
    return { kind: 'credit', amount: formatAmount(balance.slice(1), currency) };
  }
  return { kind: 'owed', amount: formatAmount(balance, currency) };
}
