import type { ContributionDetails } from '@peable.to/contracts';
// PaymentLink contract — a shareable, reusable generator of `PaymentIntent`s.
// A link's price is immutable once shared (only `active`/`metadata`/`successUrl`
// are mutable); each payer visit mints (or, at the page layer, reuses an open)
// a fresh `PaymentIntent` bound to the link's merchant/amount/currency/rail.
import type { CurrencyCode } from './money';
import type { NetworkType } from './network';
import type { MerchantDisplay } from './merchantDisplay';
import type { PaymentIntentRail } from './paymentIntent';

/** The merchant-facing DTO — returned by the merchant-authed CRUD routes. */
export interface PaymentLink {
  id: string;
  object: 'payment_link';
  contribution?: ContributionDetails;
  /**
   * Amount in the currency's smallest unit, as a canonical integer string.
   * Never a float, and never interpretable without `currency`.
   */
  amount: string;
  currency: CurrencyCode;
  rail: PaymentIntentRail;
  /** FairCoin rail only; `null` on a card link. */
  network: NetworkType | null;
  active: boolean;
  metadata: Record<string, string>;
  /** Optional post-payment redirect target for the checkout page. */
  successUrl?: string;
  /** Canonical `checkout.peable.to/l/<id>` URL. */
  url: string;
  createdAt: string;
  updatedAt: string;
}

/** What an unauthenticated checkout-page visitor may see — no secrets, no metadata. */
export interface PublicPaymentLink {
  id: string;
  object: 'payment_link';
  contribution?: ContributionDetails;
  amount: string;
  currency: CurrencyCode;
  rail: PaymentIntentRail;
  network: NetworkType | null;
  active: boolean;
  merchant: MerchantDisplay;
}

export interface CreatePaymentLinkParams {
  amount: string;
  /** Defaults to `'faircoin'`, so pre-ADR-0001 integrations keep working. */
  rail?: PaymentIntentRail;
  /** Required on the faircoin rail; refused on the card rail. */
  network?: NetworkType;
  /** Defaults to `'FAIR'` on the faircoin rail; required on the card rail. */
  currency?: CurrencyCode;
  metadata?: Record<string, string>;
  successUrl?: string;
}
