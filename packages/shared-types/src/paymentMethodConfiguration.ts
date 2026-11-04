// Payment method breadth on the card rail — which methods a merchant's payers
// are offered (`pmc_…`), and the web domains wallets may run on (`pmd_…`).
// The wire types are the contract's (`@peable.to/contracts`
// `paymentMethodConfigurationSchema`, `paymentMethodDomainSchema`); the closed
// sets are its vocabulary.
export {
  PAYMENT_METHOD_CONFIGURATION_TYPES,
  PAYMENT_METHOD_CURRENCIES,
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

/** The card-rail types a PaymentIntent can carry in `payment_method_types` (the payments vocabulary). */
export {
  CARD_RAIL_PAYMENT_METHOD_TYPES,
  type CardRailPaymentMethodType,
} from '@peable.to/contracts/vocabulary';
