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
  postal_code?: string | null;
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
  merchant_id: string;
  /** `active` once the owner approved; any edit returns it to `draft`. */
  status: 'draft' | 'active';
  legal_name: string | null;
  head_office: TaxAddress | null;
  default_tax_code: string;
  default_tax_behavior: TaxBehavior;
  calculation_account: TaxCalculationAccount;
  /** The provider that calculates registered sales, when one is reachable. */
  provider: string | null;
  approved_at: number | null;
  approved_by: string | null;
  updated_at: number | null;
}

export interface UpdateTaxSettingsParams {
  legal_name?: string | null;
  head_office?: TaxAddress | null;
  default_tax_code?: string;
  default_tax_behavior?: TaxBehavior;
}

export interface TaxRegistration {
  object: 'tax.registration';
  id: string;
  country: string;
  state: string | null;
  scheme: TaxRegistrationScheme;
  /** The government-issued number (VAT id, state permit), when there is one. */
  registration_number: string | null;
  active_from: number;
  expires_at: number | null;
  /** `pending_approval` until the owner approves; `scheduled` before activeFrom. */
  status: 'pending_approval' | 'scheduled' | 'active' | 'expired';
  approved_at: number | null;
  /** The mirrored registration at the calculating provider, once synced. */
  provider_registration_ref: string | null;
  created: number;
}

export interface CreateTaxRegistrationParams {
  country: string;
  state?: string | null;
  scheme: TaxRegistrationScheme;
  registration_number?: string | null;
  /** Unix seconds; omitted means immediately on approval. */
  active_from?: number;
  expires_at?: number | null;
}

export interface TaxProductCode {
  object: 'tax.product';
  /** The merchant's product or plan reference (a billing `planId`). */
  product_ref: string;
  tax_code: string;
  updated_at: number;
}

export type TaxLocationEvidenceItem =
  | { type: 'billing_address'; address: TaxAddress }
  | { type: 'ip_address'; ip_address: string; country: string; state?: string | null }
  | {
      type: 'payment_method_country' | 'bank_country' | 'sim_country' | 'landline_country';
      country: string;
    };

export interface CreateTaxLocationEvidenceParams {
  /** The customer this evidence is about; for billing, the `storeId`. */
  customer_ref: string;
  evidence: TaxLocationEvidenceItem[];
}

export interface TaxLocationEvidence {
  object: 'tax.location_evidence';
  id: string;
  customer_ref: string;
  /** Only `sufficient` evidence can be calculated against. */
  status: 'sufficient' | 'insufficient' | 'conflicting';
  /** The jurisdiction rule applied, e.g. `eu_digital_two_items`. */
  rule: string;
  country: string | null;
  state: string | null;
  items: { type: TaxLocationEvidenceType; country: string; state: string | null }[];
  observed_at: number;
  expires_at: number;
  livemode: boolean;
}

export interface TaxLineItemParams {
  reference: string;
  /** Unit amount × quantity, minor units. Includes tax when inclusive. */
  amount: number;
  quantity?: number;
  /** Defaults to the product's tax code, then the merchant's default. */
  tax_code?: string;
  /** Defaults to the merchant's default tax behavior. */
  tax_behavior?: TaxBehavior;
}

export interface CreateTaxCalculationParams {
  currency: string;
  customer_location_evidence_id: string;
  line_items: TaxLineItemParams[];
}

export interface TaxBreakdownEntry {
  country: string;
  state: string | null;
  level: string | null;
  display_name: string | null;
  tax_type: string | null;
  /** Decimal string, e.g. `"20.0"`; null when no tax is imposed. */
  rate_percentage: string | null;
  taxable_amount: number;
  amount: number;
  inclusive: boolean;
  /** Provider reason, or Peable's own `not_registered` / `product_nontaxable`. */
  taxability_reason: string;
}

export interface TaxCalculationLineItem {
  reference: string;
  quantity: number;
  tax_code: string;
  tax_behavior: TaxBehavior;
  /** As given: includes tax when inclusive. */
  amount: number;
  amount_tax: number;
  /** Excluding tax. */
  amount_net: number;
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
  registration_id: string | null;
  provider: string | null;
  provider_calculation_ref: string | null;
  customer_location_evidence_id: string;
  country: string;
  state: string | null;
  /** What the customer pays. */
  amount_total: number;
  amount_net: number;
  tax_amount_exclusive: number;
  tax_amount_inclusive: number;
  line_items: TaxCalculationLineItem[];
  tax_date: number;
  created: number;
  expires_at: number;
  livemode: boolean;
}

/** What a reversal gave back: the original calculation's amounts, scaled to
 * the refunded share and NEGATIVE (positive only when it reinstates an earlier
 * reversal, e.g. a refund the bank later failed). */
export interface TaxTransactionReversal {
  amount_total: number;
  amount_net: number;
  tax_amount: number;
  line_items: TaxCalculationLineItem[];
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
  calculation_id: string;
  /** The rail's own object, e.g. the invoice id. */
  reference: string;
  rail: string;
  committed_at: number;
  /** The original transaction's id, for a reversal. */
  reversal_of: string | null;
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
  has_more: boolean;
}

export interface ListTaxTransactionsParams {
  /** Inclusive, Unix seconds. */
  from: number;
  /** Exclusive, Unix seconds. */
  to: number;
  limit?: number;
  starting_after?: string;
}

/** One filing line: totals per jurisdiction, registration, tax type and rate. */
export interface TaxReportRow {
  country: string;
  state: string | null;
  registration_id: string | null;
  scheme: TaxRegistrationScheme | null;
  collection: TaxCalculation['collection'];
  tax_type: string | null;
  rate_percentage: string | null;
  currency: string;
  transactions: number;
  /** Reversals netted into this row; `taxableAmount` and `taxAmount` are net. */
  reversals: number;
  taxable_amount: number;
  tax_amount: number;
}

export interface TaxReport {
  object: 'tax.report';
  from: string;
  to: string;
  rows: TaxReportRow[];
}

/** One tax line on a signed final invoice (`include: ['tax_lines']`). */
export interface BillingInvoiceTaxLine {
  calculation_id: string;
  country: string;
  state: string | null;
  tax_type: string | null;
  rate_percentage: string | null;
  taxable_minor_units: number;
  tax_minor_units: number;
  inclusive: boolean;
  taxability_reason: string;
}
