import type { ProviderCardPreparation } from './preparedCard';
import type { PeableClientAction } from '../browser/payerClient';
export type ProviderConfirmation = { accepted: true } | { accepted: false; error: string };
export interface PeableProviderFieldsProps {
  action?: PeableClientAction;
  /** Read-only configuration can mount secure fields before payment authority exists. */
  cardConfiguration?: { readonly publishableKey: string };
  /** Billing details already collected and bound by the host's authoritative quote. */
  billingDetails?: { readonly country: string; readonly postcode: string; readonly email?: string };
  locale?: string;
  disabled?: boolean;
  /**
   * Payment authority obtained only when the payer continues, for an order
   * whose payment does not exist yet (a Checkout Session): the host records
   * the entered billing location, creates or resumes the card payment and
   * returns its client action. Its key must match the mounted fields'; a
   * thrown error's message is shown as the field error. Ignored while
   * `action` is supplied.
   */
  authorize?(billing: {
    readonly country: string;
    readonly postcode: string;
  }): Promise<PeableClientAction>;
  /** Only require a postal code when the host has an explicit billing requirement. */
  requirePostalCode?: boolean;
  returnUrl: string;
  /** Completeness publishes secure tokenization, never payment authorization or settlement. */
  onReady(prepare: (() => Promise<ProviderCardPreparation>) | null): void;
  onError?(message: string): void;
  loadingLabel?: string;
  unavailableLabel?: string;
}
