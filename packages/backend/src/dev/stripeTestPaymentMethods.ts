export interface LocalPaymentMethodCapability {
  id: 'card' | 'bank' | 'installments' | 'faircoin';
  available: boolean;
  reason?: string;
}
/** Offer capabilities of this isolated subscription harness, not account-wide methods.
 * The calling context verifies its merchant has no receive key/network. */
export function localSubscriptionPaymentMethods(
  cardAvailable: boolean,
): LocalPaymentMethodCapability[] {
  return [
    {
      id: 'card',
      available: cardAvailable,
      ...(cardAvailable ? {} : { reason: 'subscription_method_not_configured' }),
    },
    { id: 'bank', available: false, reason: 'subscription_method_not_configured' },
    { id: 'installments', available: false, reason: 'installment_offer_not_configured' },
    { id: 'faircoin', available: false, reason: 'merchant_receive_key_missing' },
  ];
}
