import type { BillingFaircoinFxQuote } from './billing';
// CheckoutSession contract — wraps exactly ONE `PaymentIntent`, created at
// session-create time, with `success_url`/`cancel_url` for a hosted checkout
// redirect flow (Stripe Checkout Session parity).
import type { CurrencyCode } from './money';
import type { NetworkType } from './network';
import type { MerchantDisplay } from './merchantDisplay';
import type { PaymentIntent, PaymentIntentRail } from './paymentIntent';

/** The merchant/SDK-facing DTO — returned on create and by merchant retrieve. */
export interface CheckoutSession {
  id: string;
  object: 'checkout_session';
  paymentIntentId: string;
  /** The wrapped intent's `client_secret`, returned to the merchant on create. */
  clientSecret: string;
  amount: string;
  currency: CurrencyCode;
  rail: PaymentIntentRail;
  /** FairCoin rail only; `null` on a card session. */
  network: NetworkType | null;
  /**
   * The seller the wrapped payment is made on behalf of (`ca_…`), or `null`
   * (ADR 0012 D5). Optional in the type for older fixtures; always sent.
   */
  connectedAccountId?: string | null;
  metadata: Record<string, string>;
  successUrl?: string;
  cancelUrl?: string;
  /** Canonical `checkout.peable.to/c/<id>` URL. */
  url: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the checkout page loads at `/c/:id`, authorized by possession of the
 * wrapped intent's `client_secret` (never a service token). `paymentIntent`
 * reuses `toPaymentIntentDTO`'s output unchanged — it already carries
 * `clientSecret`, which the page needs to open the socket and to `submit_tx`.
 */
export interface CheckoutSessionPublic {
  /** Frozen commercial USD price and exact FAIR settlement quote; no payer metadata. */
  billingQuote?: BillingFaircoinFxQuote;
  id: string;
  object: 'checkout_session';
  successUrl?: string;
  cancelUrl?: string;
  merchant: MerchantDisplay;
  paymentIntent: PaymentIntent;
}

export interface CreateCheckoutSessionParams {
  amount: string;
  /** Defaults to `'faircoin'`, so pre-ADR-0001 integrations keep working. */
  rail?: PaymentIntentRail;
  /** Required on the faircoin rail; refused on the card rail. */
  network?: NetworkType;
  /** Defaults to `'FAIR'` on the faircoin rail; required on the card rail. */
  currency?: CurrencyCode;
  metadata?: Record<string, string>;
  successUrl?: string;
  cancelUrl?: string;
  /** Pay this seller (`ca_…`) rather than the merchant — see `CreatePaymentIntentParams.connectedAccount`. */
  connectedAccount?: string;
  /** The platform's fee — see `CreatePaymentIntentParams.applicationFee`. */
  applicationFee?: string;
}
