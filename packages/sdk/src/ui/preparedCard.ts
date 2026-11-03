import type { ProviderElement, ProviderConfirmResult } from '../browser/providerJs';
import { providerAcceptedConfirmation } from './providerConfirmation';
import type { ProviderConfirmation } from './providerFieldTypes';

export interface PreparedCardAuthorization {
  /** Masked metadata only; the provider token is retained in a private closure. */
  readonly card: { brand: string; last4: string };
  confirm(): Promise<ProviderConfirmation>;
  dispose(): void;
}
export type ProviderCardPreparation =
  | { prepared: true; authorization: PreparedCardAuthorization }
  | { prepared: false; error: string };
export interface CardPreparationProvider {
  createPaymentMethod(data: {
    type: 'card';
    card: ProviderElement;
    billing_details: { address: { country: string; postal_code: string } };
  }): Promise<{
    error?: { message?: string };
    paymentMethod?: { id: string; card?: { brand?: string; last4?: string } };
  }>;
  confirmCardPayment(
    secret: string,
    data: { payment_method: string; return_url?: string },
  ): Promise<ProviderConfirmResult>;
}
/** Tokenizes secure provider-owned nodes, never charges. No values can enter through this API. */
export async function prepareCardAuthorization({
  provider,
  card,
  billing,
  clientSecret,
  returnUrl,
  messages,
}: {
  provider: CardPreparationProvider;
  card: ProviderElement;
  billing: { country: string; postcode: string };
  clientSecret: string;
  returnUrl: string;
  messages: { failed: string; incomplete: string; busy: string; closed: string };
}): Promise<ProviderCardPreparation> {
  const result = await provider.createPaymentMethod({
    type: 'card',
    card,
    billing_details: { address: { country: billing.country, postal_code: billing.postcode } },
  });
  if (result.error) return { prepared: false, error: result.error.message ?? messages.failed };
  const method = result.paymentMethod;
  if (!method || !/^pm_[A-Za-z0-9]+$/.test(method.id) || !/^\d{4}$/.test(method.card?.last4 ?? ''))
    return { prepared: false, error: messages.failed };
  let token = method.id;
  let secret = clientSecret;
  let disposed = false;
  let busy = false;
  let accepted = false;
  return {
    prepared: true,
    authorization: {
      card: { brand: method.card?.brand ?? 'Card', last4: method.card?.last4 ?? '' },
      dispose() {
        disposed = true;
        token = '';
        secret = '';
      },
      async confirm() {
        if (disposed) return { accepted: false, error: messages.closed };
        if (busy) return { accepted: false, error: messages.busy };
        if (accepted) return { accepted: true };
        busy = true;
        try {
          const confirmation = await provider.confirmCardPayment(secret, {
            payment_method: token,
            return_url: returnUrl,
          });
          if (disposed) return { accepted: false, error: messages.closed };
          if (confirmation.error)
            return { accepted: false, error: confirmation.error.message ?? messages.failed };
          accepted = providerAcceptedConfirmation(confirmation);
          return accepted ? { accepted: true } : { accepted: false, error: messages.incomplete };
        } catch {
          return { accepted: false, error: messages.failed };
        } finally {
          busy = false;
        }
      },
    },
  };
}
