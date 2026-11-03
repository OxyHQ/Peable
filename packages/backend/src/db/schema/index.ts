/**
 * The schema object drizzle and drizzle-kit are both built from.
 *
 * This is the one barrel this package has, and it exists because drizzle's
 * `drizzle(client, { schema })` and drizzle-kit's `schema:` both take a MODULE,
 * not a list of tables — a table missing from here is a table drizzle-kit never
 * generates DDL for and drizzle cannot resolve a relation through.
 */

export { merchants } from './merchants';
export { checkoutSessions, paymentIntents, paymentLinks } from './payments';
export { customerProviderBindings, customers, paymentMethods } from './customers';
export { charges } from './charges';
export { setupIntents } from './setupIntents';
export {
  SOCIAL_RECEIVE_FIRST_FRESH_INDEX,
  socialReceiveCursors,
  socialSendAttributions,
} from './social';
export { events } from './events';
export { webhookDeliveries, webhookEndpoints } from './webhooks';
export { providerEvents, providerEventsReceivedSeq } from './providerEvents';
export { connectedAccountLinks, connectedAccounts } from './connectedAccounts';
export { transferReversals, transfers } from './transfers';
export { refunds } from './refunds';
export { disputeEvidenceFiles, disputes } from './disputes';
export { files } from './files';
export {
  paymentMethodConfigurationBindings,
  paymentMethodConfigurations,
  paymentMethodDomains,
} from './paymentMethodConfigurations';
export { idempotencyKeys } from './idempotency';
export { couponProducts, coupons, prices, products, promotionCodes } from './catalog';
export { apiRequestLogs } from './requestLogs';
export {
  applicationFeeRefunds,
  applicationFees,
  balanceTransactions,
  feeSchedules,
  ledgerEntries,
  payouts,
  reconciliationMismatches,
} from './money';
export {
  checkoutSessionLineItems,
  customerEmails,
  merchantBranding,
  merchantEmailSettings,
  paymentLinkLineItems,
} from './checkout';
export { testClocks } from './testClocks';
export { billingMeters } from './meters';
export {
  billingMeterEvents,
  billingPortalConfigurations,
  billingPortalSessions,
  billingSettings,
  creditNoteLines,
  creditNotes,
  customerBalanceTransactions,
  customerEntitlementSummaries,
  entitlementFeatures,
  invoiceItems,
  invoiceLineItems,
  invoices,
  productFeatures,
  subscriptionItems,
  subscriptions,
} from './billingEngine';

export { recurringMirrors, recurringObservationOutbox } from './recurring';
export { billingObjectBindings, billingOperations, billingRenewalTaxes } from './billing';
export { faircoinRenewalAuthorizations } from './faircoinRenewals';
export { faircoinBillingSubscriptions, faircoinBillingInvoices } from './faircoinBilling';
export {
  taxSettings,
  taxRegistrations,
  taxProductCodes,
  taxLocationEvidence,
  taxCalculations,
  taxTransactions,
} from './tax';
export {
  taxBusinessProfiles,
  taxComplianceActions,
  taxComplianceAssessments,
  taxComplianceDocuments,
  taxOperatingLocations,
  taxRegistrationDeclarations,
  taxReviewItems,
  taxSalesDestinations,
} from './taxCompliance';
export {
  merchantAvatarAudit,
  oxyFileEvents,
  oxyFileReconciliationRuns,
  oxyFileReferenceSyncs,
} from './oxyFiles';
export { reportRuns } from './reporting';
