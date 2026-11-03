/** One Peable method this isolated harness offer could take (ADR 0014 wire). */
export interface LocalPaymentMethodCapability {
  type: 'card' | 'bank' | 'installments' | 'faircoin';
  available: boolean;
  /** Why it cannot be offered here; `null` when it can. */
  unavailable_reason: string | null;
}
/** Offer capabilities of this isolated subscription harness, not account-wide methods.
 * The calling context verifies its merchant has no receive key/network. */
export function localSubscriptionPaymentMethods(
  cardAvailable: boolean,
): LocalPaymentMethodCapability[] {
  return [
    {
      type: 'card',
      available: cardAvailable,
      unavailable_reason: cardAvailable ? null : 'subscription_method_not_configured',
    },
    { type: 'bank', available: false, unavailable_reason: 'subscription_method_not_configured' },
    {
      type: 'installments',
      available: false,
      unavailable_reason: 'installment_offer_not_configured',
    },
    { type: 'faircoin', available: false, unavailable_reason: 'merchant_receive_key_missing' },
  ];
}
