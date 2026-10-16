/**
 * Peable Tax — the wire contract.
 *
 * Modelled on Stripe Tax and applied to every settlement rail (card, FairCoin,
 * any further fiat provider). A merchant declares WHERE it is registered;
 * Peable decides per sale whether a registration covers the customer's
 * evidenced location, asks a tax provider for the amount only when one does,
 * and freezes the answer. Registering with a government is the seller's job,
 * never this code's.
 *
 * Amounts are integers in the currency's minor unit, like the billing quote.
 */

/** How a registration lets the seller collect. `standard`/`simplified` cover
 * one country; the EU One-Stop-Shop schemes cover every EU member state from
 * one identification state; the US is per state; Canadian PST/QST is per
 * province. */
export const TAX_REGISTRATION_SCHEMES = [
  'standard',
  'simplified',
  'eu_oss_union',
  'eu_oss_non_union',
  'us_state_sales_tax',
  'ca_provincial',
] as const;
export type TaxRegistrationScheme = (typeof TAX_REGISTRATION_SCHEMES)[number];

/** Location evidence a jurisdiction accepts. There is deliberately no
 * language, currency, locale or timezone: none of them is evidence of where a
 * customer lives, and Peable cannot be told otherwise. */
export const TAX_LOCATION_EVIDENCE_TYPES = [
  'billing_address',
  'ip_address',
  'payment_method_country',
  'bank_country',
  'sim_country',
  'landline_country',
] as const;
export type TaxLocationEvidenceType = (typeof TAX_LOCATION_EVIDENCE_TYPES)[number];

export type TaxBehavior = 'inclusive' | 'exclusive';

export interface TaxAddress {
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** ISO 3166-2 subdivision without the country prefix (`CA`, `QC`). */
  state?: string | null;
  postalCode?: string | null;
  city?: string | null;
  line1?: string | null;
  line2?: string | null;
}

export interface TaxCode {
  id: string;
  name: string;
  description: string;
}

/** Which provider account calculates for this merchant. `platform`: Peable's
 * own provider account, available only to official Oxy applications, whose
 * seller is the platform's legal entity. `none`: no provider; sales in a
 * registered jurisdiction cannot be calculated and fail closed. */
export type TaxCalculationAccount = 'platform' | 'none';

export interface TaxSettings {
  object: 'tax.settings';
  merchantId: string;
  /** `active` once the owner approved; any edit returns it to `draft`. */
  status: 'draft' | 'active';
  legalName: string | null;
  headOffice: TaxAddress | null;
  defaultTaxCode: string;
  defaultTaxBehavior: TaxBehavior;
  calculationAccount: TaxCalculationAccount;
  /** The provider that calculates registered sales, when one is reachable. */
  provider: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  updatedAt: string | null;
}

export interface UpdateTaxSettingsParams {
  legalName?: string | null;
  headOffice?: TaxAddress | null;
  defaultTaxCode?: string;
  defaultTaxBehavior?: TaxBehavior;
}

export interface TaxRegistration {
  object: 'tax.registration';
  id: string;
  country: string;
  state: string | null;
  scheme: TaxRegistrationScheme;
  /** The government-issued number (VAT id, state permit), when there is one. */
  registrationNumber: string | null;
  activeFrom: string;
  expiresAt: string | null;
  /** `pending_approval` until the owner approves; `scheduled` before activeFrom. */
  status: 'pending_approval' | 'scheduled' | 'active' | 'expired';
  approvedAt: string | null;
  /** The mirrored registration at the calculating provider, once synced. */
  providerRegistrationRef: string | null;
  createdAt: string;
}

export interface CreateTaxRegistrationParams {
  country: string;
  state?: string | null;
  scheme: TaxRegistrationScheme;
  registrationNumber?: string | null;
  /** ISO timestamp; omitted means immediately on approval. */
  activeFrom?: string;
  expiresAt?: string | null;
}

export interface TaxProductCode {
  object: 'tax.product';
  /** The merchant's product or plan reference (a billing `planId`). */
  productRef: string;
  taxCode: string;
  updatedAt: string;
}

export type TaxLocationEvidenceItem =
  | { type: 'billing_address'; address: TaxAddress }
  | { type: 'ip_address'; ipAddress: string; country: string; state?: string | null }
  | {
      type: 'payment_method_country' | 'bank_country' | 'sim_country' | 'landline_country';
      country: string;
    };

export interface CreateTaxLocationEvidenceParams {
  /** The customer this evidence is about; for billing, the `storeId`. */
  customerRef: string;
  evidence: TaxLocationEvidenceItem[];
}

export interface TaxLocationEvidence {
  object: 'tax.location_evidence';
  id: string;
  customerRef: string;
  /** Only `sufficient` evidence can be calculated against. */
  status: 'sufficient' | 'insufficient' | 'conflicting';
  /** The jurisdiction rule applied, e.g. `eu_digital_two_items`. */
  rule: string;
  country: string | null;
  state: string | null;
  items: { type: TaxLocationEvidenceType; country: string; state: string | null }[];
  observedAt: string;
  expiresAt: string;
  livemode: boolean;
}

export interface TaxLineItemParams {
  reference: string;
  /** Unit amount × quantity, minor units. Includes tax when inclusive. */
  amount: number;
  quantity?: number;
  /** Defaults to the product's tax code, then the merchant's default. */
  taxCode?: string;
  /** Defaults to the merchant's default tax behavior. */
  taxBehavior?: TaxBehavior;
}

export interface CreateTaxCalculationParams {
  currency: string;
  customerLocationEvidenceId: string;
  lineItems: TaxLineItemParams[];
}

export interface TaxBreakdownEntry {
  country: string;
  state: string | null;
  level: string | null;
  displayName: string | null;
  taxType: string | null;
  /** Decimal string, e.g. `"20.0"`; null when no tax is imposed. */
  ratePercentage: string | null;
  taxableAmount: number;
  amount: number;
  inclusive: boolean;
  /** Provider reason, or Peable's own `not_registered` / `product_nontaxable`. */
  taxabilityReason: string;
}

export interface TaxCalculationLineItem {
  reference: string;
  quantity: number;
  taxCode: string;
  taxBehavior: TaxBehavior;
  /** As given: includes tax when inclusive. */
  amount: number;
  amountTax: number;
  /** Excluding tax. */
  amountNet: number;
  breakdown: TaxBreakdownEntry[];
}

/** A frozen answer. `collection` says why the tax is what it is:
 * `collect` (a registration covers the customer and the provider calculated),
 * `not_registered` (no registration covers them: zero tax, recorded as such),
 * `nontaxable` (every line used the nontaxable code). */
export interface TaxCalculation {
  object: 'tax.calculation';
  id: string;
  currency: string;
  collection: 'collect' | 'not_registered' | 'nontaxable';
  registrationId: string | null;
  provider: string | null;
  providerCalculationRef: string | null;
  customerLocationEvidenceId: string;
  country: string;
  state: string | null;
  /** What the customer pays. */
  amountTotal: number;
  amountNet: number;
  taxAmountExclusive: number;
  taxAmountInclusive: number;
  lineItems: TaxCalculationLineItem[];
  taxDate: string;
  createdAt: string;
  expiresAt: string;
  livemode: boolean;
}

/** What a reversal gave back: the original calculation's amounts, scaled to
 * the refunded share and NEGATIVE (positive only when it reinstates an earlier
 * reversal, e.g. a refund the bank later failed). */
export interface TaxTransactionReversal {
  amountTotal: number;
  amountNet: number;
  taxAmount: number;
  lineItems: TaxCalculationLineItem[];
}

/** A calculation that was paid. Created by Peable when the payment it priced
 * is accepted on its rail; the report and filings are built from these.
 *
 * `type: "reversal"` is a refund (or credit note) of an earlier transaction,
 * `reversalOf` names it, and `reversal` holds its signed amounts. The report
 * nets reversals into the rows of the original. */
export interface TaxTransaction {
  object: 'tax.transaction';
  id: string;
  type: 'transaction' | 'reversal';
  calculationId: string;
  /** The rail's own object, e.g. the invoice id. */
  reference: string;
  rail: string;
  committedAt: string;
  /** The original transaction's id, for a reversal. */
  reversalOf: string | null;
  reversal: TaxTransactionReversal | null;
  calculation: TaxCalculation;
}

/** Record a refund made outside Peable (a FairCoin rail payment is refunded
 * from the seller's own wallet, never by the gateway). Card refunds and credit
 * notes are observed from the provider instead. */
export interface CreateTaxReversalParams {
  /** The refund's own reference; a repeated reference returns the same reversal. */
  reference: string;
  /** Gross minor units refunded (what the payer got back). Omitted: everything
   * that is not yet reversed. */
  amount?: number;
}

export interface TaxTransactionList {
  object: 'list';
  data: TaxTransaction[];
  hasMore: boolean;
}

export interface ListTaxTransactionsParams {
  /** Inclusive ISO timestamp. */
  from: string;
  /** Exclusive ISO timestamp. */
  to: string;
  limit?: number;
  startingAfter?: string;
}

/** One filing line: totals per jurisdiction, registration, tax type and rate. */
export interface TaxReportRow {
  country: string;
  state: string | null;
  registrationId: string | null;
  scheme: TaxRegistrationScheme | null;
  collection: TaxCalculation['collection'];
  taxType: string | null;
  ratePercentage: string | null;
  currency: string;
  transactions: number;
  /** Reversals netted into this row; `taxableAmount` and `taxAmount` are net. */
  reversals: number;
  taxableAmount: number;
  taxAmount: number;
}

export interface TaxReport {
  object: 'tax.report';
  from: string;
  to: string;
  rows: TaxReportRow[];
}

/** One tax line on a signed final invoice (`include: ['tax_lines']`). */
export interface BillingInvoiceTaxLine {
  calculationId: string;
  country: string;
  state: string | null;
  taxType: string | null;
  ratePercentage: string | null;
  taxableMinorUnits: number;
  taxMinorUnits: number;
  inclusive: boolean;
  taxabilityReason: string;
}
