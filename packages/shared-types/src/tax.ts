// Peable Tax (ADR 0011). The wire types are the contract's (`@peable.to/contracts`
// `resources/tax`), re-exported here as types so a consumer needs no schema at
// runtime; the closed value sets are the contract's zod-free vocabulary.
//
// Modelled on Stripe Tax and applied to every settlement rail (card, FairCoin,
// any further fiat provider). A merchant declares WHERE it is registered;
// Peable decides per sale whether a registration covers the customer's
// evidenced location, asks a tax provider for the amount only when one does,
// and freezes the answer. Registering with a government is the seller's job,
// never this code's.
export {
  DEFAULT_TAX_CODE,
  isKnownTaxCode,
  NONTAXABLE_TAX_CODE,
  TAX_BEHAVIORS,
  TAX_CALCULATION_ACCOUNTS,
  TAX_CODES,
  TAX_COLLECTIONS,
  TAX_EVIDENCE_STATUSES,
  TAX_LOCATION_EVIDENCE_TYPES,
  TAX_REGISTRATION_SCHEMES,
  TAX_REGISTRATION_STATUSES,
  TAX_SETTINGS_STATUSES,
  TAX_TRANSACTION_TYPES,
  type TaxBehavior,
  type TaxCalculationAccount,
  type TaxCollection,
  type TaxLocationEvidenceStatus,
  type TaxLocationEvidenceType,
  type TaxRegistrationScheme,
  type TaxRegistrationStatus,
  type TaxSettingsStatus,
  type TaxTransactionType,
} from '@peable.to/contracts/vocabulary';
export type {
  CreateTaxCalculationParams,
  CreateTaxLocationEvidenceParams,
  CreateTaxRegistrationParams,
  CreateTaxReversalParams,
  EndTaxRegistrationParams,
  ListTaxTransactionsParams,
  SetTaxProductCodeParams,
  TaxAddress,
  TaxAddressParams,
  TaxBreakdownEntry,
  TaxCalculation,
  TaxCalculationLineItem,
  TaxCode,
  TaxLineItemParams,
  TaxLocationEvidence,
  TaxLocationEvidenceItem,
  TaxProductCode,
  TaxRegistration,
  TaxReport,
  TaxReportParams,
  TaxReportRow,
  TaxSettings,
  TaxTransaction,
  TaxTransactionList,
  TaxTransactionReversal,
  UpdateTaxSettingsParams,
} from '@peable.to/contracts';

/** One tax line on a signed final invoice — the billing surface's contract. */
export type { BillingInvoiceTaxLine } from '@peable.to/contracts';

// Business compliance (ADR 0020) travels with the `/tax` subpath, so a browser
// bundle reaches it without the root barrel's node:crypto signer.
export * from './taxCompliance';
