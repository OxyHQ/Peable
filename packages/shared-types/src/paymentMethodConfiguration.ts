// Payment method breadth on the card rail — which methods a merchant's payers
// are offered (`pmc_…`), and the web domains wallets may run on (`pmd_…`).
// The wire types are the contract's (`@peable.to/contracts`
// `paymentMethodConfigurationSchema`, `paymentMethodDomainSchema`); the closed
// sets are its vocabulary.
import {
  FIAT_CURRENCY_CODES,
  type FiatCurrencyCode,
  type PaymentMethodConfigurationType,
} from '@peable.to/contracts/vocabulary';

export {
  PAYMENT_METHOD_CONFIGURATION_TYPES,
  PAYMENT_METHOD_UNAVAILABLE_REASONS,
  type PaymentMethodConfigurationType,
  type PaymentMethodUnavailableReason,
} from '@peable.to/contracts/vocabulary';
export type {
  CreatePaymentMethodConfigurationParams,
  CreatePaymentMethodDomainParams,
  ListPaymentMethodDomainsParams,
  PaymentMethodConfiguration,
  PaymentMethodConfigurationEntry,
  PaymentMethodConfigurationEntryParams,
  PaymentMethodDisplayPreference,
  PaymentMethodDomain,
  PaymentMethodDomainWalletStatus,
  UpdatePaymentMethodConfigurationParams,
  UpdatePaymentMethodDomainParams,
} from '@peable.to/contracts';

/** The card-rail types a PaymentIntent can carry in `payment_method_types`. */
export const CARD_RAIL_PAYMENT_METHOD_TYPES = [
  'card',
  'sepa_debit',
  'ideal',
  'bancontact',
  'eps',
] as const;
export type CardRailPaymentMethodType = (typeof CARD_RAIL_PAYMENT_METHOD_TYPES)[number];

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
