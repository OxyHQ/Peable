import type { CheckoutSessionAction } from './preparedCheckoutSession';
import type { ProviderCardPreparation } from './preparedCard';
import type { PeableClientAction } from '../browser/payerClient';
export type ProviderConfirmation = { accepted: true } | { accepted: false; error: string };
export interface PeableProviderFieldsProps {
  action?: PeableClientAction;
  /** A subscription Checkout Session is distinct from a PaymentIntent secret. Never pass both. */
  checkoutSession?: CheckoutSessionAction;
  /** Read-only configuration can mount secure fields before payment authority exists. */
  cardConfiguration?: { readonly publishableKey: string };
  /** Billing details already collected and bound by the host's authoritative quote. */
  billingDetails?: { readonly country: string; readonly postcode: string };
  locale?: string;
  disabled?: boolean;
  /** Only require a postal code when the host has an explicit billing requirement. */
  requirePostalCode?: boolean;
  returnUrl: string;
  /** Completeness publishes secure tokenization, never payment authorization or settlement. */
  onReady(prepare: (() => Promise<ProviderCardPreparation>) | null): void;
  onError?(message: string): void;
  loadingLabel?: string;
  unavailableLabel?: string;
}
