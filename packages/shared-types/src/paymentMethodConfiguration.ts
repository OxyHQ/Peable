// Payment method breadth on the card rail — which methods a merchant's payers
// are offered (`pmc_…`), and the web domains wallets may run on (`pmd_…`).
// Both are Orbit's objects; the provider's configuration and domain are
// bindings behind them (ADR 0016). Card data and bank credentials are entered
// in the provider's hosted fields and never reach Peable (PCI SAQ-A).
import { FIAT_CURRENCY_CODES, type FiatCurrencyCode } from './money';

/**
 * The methods a configuration can turn on.
 *
 * `apple_pay` and `google_pay` are WALLETS over a card: a payment made with one
 * is a `card` payment, so they appear here and never in a PaymentIntent's
 * `payment_method_types`. `bizum` is listed because merchants ask for it and the
 * honest answer is a reason, not an absence: the provider does not offer it.
 *
 * Deliberately absent: the provider's own consumer wallet (its brand on Orbit's
 * checkout, `payment-provider-boundary.md`) and giropay (discontinued by the
 * scheme).
 */
export const PAYMENT_METHOD_CONFIGURATION_TYPES = [
  'card',
  'apple_pay',
  'google_pay',
  'sepa_debit',
  'ideal',
  'bancontact',
  'eps',
  'bizum',
] as const;
export type PaymentMethodConfigurationType = (typeof PAYMENT_METHOD_CONFIGURATION_TYPES)[number];

/** The card-rail types a PaymentIntent can carry in `payment_method_types` (the payments vocabulary). */
export {
  CARD_RAIL_PAYMENT_METHOD_TYPES,
  type CardRailPaymentMethodType,
} from '@peable.to/contracts/vocabulary';

/**
 * Why a method cannot be offered whatever the merchant chooses.
 *
 *  - `provider_unsupported` — the processing provider does not offer it;
 *  - `requires_card` — a wallet rides on card payments, and card is off.
 */
export type PaymentMethodUnavailableReason = 'provider_unsupported' | 'requires_card';

/**
 * The currencies each method can take a payment in. A method is offered on a
 * payment only when its currency is listed — so iDEAL never appears on a USD
 * payment, and a payer is never shown a method that would fail.
 */
export const PAYMENT_METHOD_CURRENCIES: Readonly<
  Record<PaymentMethodConfigurationType, readonly FiatCurrencyCode[]>
> = Object.freeze({
  card: FIAT_CURRENCY_CODES,
  apple_pay: FIAT_CURRENCY_CODES,
  google_pay: FIAT_CURRENCY_CODES,
  sepa_debit: ['EUR'],
  ideal: ['EUR'],
  bancontact: ['EUR'],
  eps: ['EUR'],
  bizum: ['EUR'],
});

/** The merchant's choice (`none`: Orbit's default) and what is in effect. */
export interface PaymentMethodDisplayPreference {
  preference: 'on' | 'off' | 'none';
  value: 'on' | 'off';
}

export interface PaymentMethodConfigurationEntry {
  /** Whether payers can be offered this method: it is on and nothing prevents it. */
  available: boolean;
  display_preference: PaymentMethodDisplayPreference;
  /** Why it cannot be offered whatever the merchant chooses; `null` when it can. */
  unavailable_reason: PaymentMethodUnavailableReason | null;
  /** The payment currencies it is offered on. */
  currencies: readonly FiatCurrencyCode[];
}

export type PaymentMethodConfiguration = {
  /** `pmc_…`. */
  id: string;
  object: 'payment_method_configuration';
  livemode: boolean;
  name: string;
  /** An inactive configuration cannot be named on a new PaymentIntent. The default is always active. */
  active: boolean;
  /** The configuration a PaymentIntent uses when it names none. Exactly one per merchant. */
  is_default: boolean;
  created: number;
  updated_at: number;
} & { [K in PaymentMethodConfigurationType]: PaymentMethodConfigurationEntry };

/** One method's setting in a create or update. */
export interface PaymentMethodConfigurationEntryParams {
  display_preference: { preference: 'on' | 'off' | 'none' };
}

/** `POST /v1/payment_method_configurations`. */
export type CreatePaymentMethodConfigurationParams = {
  name?: string;
} & { [K in PaymentMethodConfigurationType]?: PaymentMethodConfigurationEntryParams };

/** `POST /v1/payment_method_configurations/:id`. */
export type UpdatePaymentMethodConfigurationParams = CreatePaymentMethodConfigurationParams & {
  active?: boolean;
};

/** A wallet's standing on one domain. */
export interface PaymentMethodDomainWalletStatus {
  /** `active`: the wallet can run on pages served from this domain. */
  status: 'active' | 'inactive';
  /** Present while `inactive`: what the wallet's verification said, in Peable's words. */
  status_details: { error_message: string } | null;
}

/**
 * A web domain the merchant serves payment pages from (`pmd_…`), registered so
 * Apple Pay and Google Pay run there. Peable's own hosted checkout needs none:
 * its domain is Peable's.
 */
export interface PaymentMethodDomain {
  id: string;
  object: 'payment_method_domain';
  livemode: boolean;
  /** Lowercase hostname, no scheme, port or path. */
  domain_name: string;
  /** Whether wallets may run on it at all. */
  enabled: boolean;
  apple_pay: PaymentMethodDomainWalletStatus;
  google_pay: PaymentMethodDomainWalletStatus;
  created: number;
}

/** `POST /v1/payment_method_domains`. */
export interface CreatePaymentMethodDomainParams {
  domain_name: string;
  enabled?: boolean;
}

/** `POST /v1/payment_method_domains/:id`. */
export interface UpdatePaymentMethodDomainParams {
  enabled?: boolean;
}

/** `GET /v1/payment_method_domains`. */
export interface ListPaymentMethodDomainsParams {
  domain_name?: string;
  enabled?: boolean;
}
