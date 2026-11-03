// Peable Tax vocabulary (ADR 0011, ADR 0020): the closed value sets the tax
// contracts are built from, and the database mirrors as CHECKs. Zod-free, so
// Orbit and the shared types read them at runtime without constructing a schema.

// ── Collection (ADR 0011) ────────────────────────────────────────────────────

/**
 * How a registration lets the seller collect. `standard`/`simplified` cover one
 * country; the EU One-Stop-Shop schemes cover every EU member state from one
 * identification state; the US is per state; Canadian PST/QST is per province.
 */
export const TAX_REGISTRATION_SCHEMES = [
  'standard',
  'simplified',
  'eu_oss_union',
  'eu_oss_non_union',
  'us_state_sales_tax',
  'ca_provincial',
] as const;
export type TaxRegistrationScheme = (typeof TAX_REGISTRATION_SCHEMES)[number];

/**
 * Location evidence a jurisdiction accepts. There is deliberately no language,
 * currency, locale or timezone: none of them is evidence of where a customer
 * lives, and Peable cannot be told otherwise.
 */
export const TAX_LOCATION_EVIDENCE_TYPES = [
  'billing_address',
  'ip_address',
  'payment_method_country',
  'bank_country',
  'sim_country',
  'landline_country',
] as const;
export type TaxLocationEvidenceType = (typeof TAX_LOCATION_EVIDENCE_TYPES)[number];

/** Whether a line's amount includes its tax (`inclusive`) or tax is added on top. */
export const TAX_BEHAVIORS = ['inclusive', 'exclusive'] as const;
export type TaxBehavior = (typeof TAX_BEHAVIORS)[number];

/** `active` once the owner approved; any edit returns the settings to `draft`. */
export const TAX_SETTINGS_STATUSES = ['draft', 'active'] as const;
export type TaxSettingsStatus = (typeof TAX_SETTINGS_STATUSES)[number];

/**
 * Which provider account calculates for a merchant. `platform`: Peable's own
 * provider account, available only to official Oxy applications, whose seller
 * is the platform's legal entity. `none`: no provider; sales in a registered
 * jurisdiction cannot be calculated and fail closed.
 */
export const TAX_CALCULATION_ACCOUNTS = ['platform', 'none'] as const;
export type TaxCalculationAccount = (typeof TAX_CALCULATION_ACCOUNTS)[number];

/** `pending_approval` until the owner approves; `scheduled` before `active_from`. */
export const TAX_REGISTRATION_STATUSES = [
  'pending_approval',
  'scheduled',
  'active',
  'expired',
] as const;
export type TaxRegistrationStatus = (typeof TAX_REGISTRATION_STATUSES)[number];

/** Only `sufficient` evidence can be calculated against. */
export const TAX_EVIDENCE_STATUSES = ['sufficient', 'insufficient', 'conflicting'] as const;
export type TaxLocationEvidenceStatus = (typeof TAX_EVIDENCE_STATUSES)[number];

/**
 * Why a calculation's tax is what it is: `collect` (a registration covers the
 * customer and the provider calculated), `not_registered` (no registration
 * covers them: zero tax, recorded as such), `nontaxable` (every line used the
 * nontaxable code).
 */
export const TAX_COLLECTIONS = ['collect', 'not_registered', 'nontaxable'] as const;
export type TaxCollection = (typeof TAX_COLLECTIONS)[number];

/** A sale, or a refund (or credit note) of one. */
export const TAX_TRANSACTION_TYPES = ['transaction', 'reversal'] as const;
export type TaxTransactionType = (typeof TAX_TRANSACTION_TYPES)[number];

/**
 * The product tax codes Peable accepts, starting with digital services and
 * SaaS — what every Oxy application sells. Ids are Stripe Tax's tax codes, so a
 * code means the same thing to Peable and to the provider calculating it.
 * Adding a category is adding a row here; classifying a product is the seller's
 * decision.
 */
export const TAX_CODES = Object.freeze([
  {
    id: 'txcd_00000000',
    name: 'Nontaxable',
    description: 'A product that is not subject to tax anywhere. No tax is calculated.',
  },
  {
    id: 'txcd_10000000',
    name: 'General - Electronically Supplied Services',
    description:
      'A service delivered electronically over the internet with minimal human involvement.',
  },
  {
    id: 'txcd_10103000',
    name: 'Software as a service (SaaS) - personal use',
    description: 'Hosted software accessed online, sold to consumers for personal use.',
  },
  {
    id: 'txcd_10103001',
    name: 'Software as a service (SaaS) - business use',
    description: 'Hosted software accessed online, sold to businesses for business use.',
  },
  {
    id: 'txcd_10202000',
    name: 'Downloadable Software - personal use',
    description: 'Software downloaded to the customer’s device, for personal use.',
  },
  {
    id: 'txcd_10202003',
    name: 'Downloadable Software - business use',
    description: 'Software downloaded to the customer’s device, for business use.',
  },
  {
    id: 'txcd_10701100',
    name: 'Website Hosting',
    description: 'Hosting of a website or web application on the seller’s servers.',
  },
] as const);

/** The code of a product that is taxed nowhere. */
export const NONTAXABLE_TAX_CODE = 'txcd_00000000';

/** The code a merchant's settings start with: electronically supplied services. */
export const DEFAULT_TAX_CODE = 'txcd_10000000';

const KNOWN_TAX_CODES: ReadonlySet<string> = new Set(TAX_CODES.map((code) => code.id));

/** Whether `id` is one of {@link TAX_CODES}. */
export function isKnownTaxCode(id: string): boolean {
  return KNOWN_TAX_CODES.has(id);
}

// ── Business compliance (ADR 0020) ───────────────────────────────────────────

/** `unknown` is an answer, not a gap: the owner says they do not know yet. */
export const TAX_LEGAL_ENTITY_TYPES = [
  'corporation',
  'limited_liability_company',
  'partnership',
  'sole_proprietorship',
  'nonprofit',
  'public_body',
  'other',
  'unknown',
] as const;
export type TaxLegalEntityType = (typeof TAX_LEGAL_ENTITY_TYPES)[number];

export const TAX_CUSTOMER_TYPES = ['consumers', 'businesses', 'both', 'unknown'] as const;
export type TaxCustomerType = (typeof TAX_CUSTOMER_TYPES)[number];

export const TAX_SUPPLY_TYPES = [
  'digital_services',
  'software_as_a_service',
  'physical_goods',
  'professional_services',
  'other',
] as const;
export type TaxSupplyType = (typeof TAX_SUPPLY_TYPES)[number];

/**
 * Where the business ACTUALLY operates. `head_office` and `fixed_establishment`
 * are the owner's statement of establishment (the EU rule reads them); any
 * location in a US state is physical presence there.
 */
export const TAX_OPERATING_LOCATION_KINDS = [
  'head_office',
  'fixed_establishment',
  'office',
  'warehouse',
  'employees',
  'inventory',
  'other',
] as const;
export type TaxOperatingLocationKind = (typeof TAX_OPERATING_LOCATION_KINDS)[number];

/**
 * Where the business stands with a tax authority, IN ITS OWN WORDS.
 *
 *  - `unknown` — the owner does not know; an assessment escalates it.
 *  - `not_registered` — the owner says there is no registration.
 *  - `application_pending` — an application was made outside Peable and the
 *    authority has not answered: an ambiguous outcome, never treated as
 *    registered.
 *  - `registered` — the owner says the authority registered the business, from
 *    `effective_from`.
 *  - `rejected` — the authority refused the application.
 *  - `ended` — the registration ended at `effective_to`.
 */
export const TAX_REGISTRATION_DECLARATION_STATUSES = [
  'unknown',
  'not_registered',
  'application_pending',
  'registered',
  'rejected',
  'ended',
] as const;
export type TaxRegistrationDeclarationStatus =
  (typeof TAX_REGISTRATION_DECLARATION_STATUSES)[number];

export const TAX_FILING_FREQUENCIES = ['monthly', 'quarterly', 'annual', 'unknown'] as const;
export type TaxFilingFrequency = (typeof TAX_FILING_FREQUENCIES)[number];

export const TAX_DOCUMENT_KINDS = [
  'registration_certificate',
  'authority_correspondence',
  'incorporation_record',
  'filing_confirmation',
  'payment_receipt',
  'other',
] as const;
export type TaxDocumentKind = (typeof TAX_DOCUMENT_KINDS)[number];

/** `provided`: an available document is attached; `unavailable`: only removed ones are. */
export const TAX_DOCUMENT_CHECKLIST_STATUSES = ['provided', 'missing', 'unavailable'] as const;
export type TaxDocumentChecklistStatus = (typeof TAX_DOCUMENT_CHECKLIST_STATUSES)[number];

/** The tax a jurisdiction rule is about. */
export const TAX_TYPES = ['vat', 'sales_tax'] as const;
export type TaxType = (typeof TAX_TYPES)[number];

/** The window a rule's threshold is measured over. */
export const TAX_THRESHOLD_PERIODS = [
  'current_or_previous_calendar_year',
  'preceding_twelve_calendar_months',
] as const;
export type TaxThresholdPeriod = (typeof TAX_THRESHOLD_PERIODS)[number];

/** Whether a tax professional has signed a rule off. */
export const TAX_RULE_REVIEW_STATUSES = ['unreviewed', 'reviewed'] as const;
export type TaxRuleReviewStatus = (typeof TAX_RULE_REVIEW_STATUSES)[number];

/**
 * What an assessment found for one jurisdiction.
 *
 *  - `registration_declared` — the owner declares a registration in force.
 *  - `likely_required` — the rule indicates an obligation; a person decides.
 *  - `approaching_threshold` — at or above 80% of the threshold.
 *  - `not_indicated` — nothing in the recorded facts indicates one.
 *  - `uncertain` — the facts are missing or contradictory; escalated.
 *  - `unsupported` — sales exist where no supported rule applies.
 */
export const TAX_OBLIGATION_OUTCOMES = [
  'registration_declared',
  'likely_required',
  'approaching_threshold',
  'not_indicated',
  'uncertain',
  'unsupported',
] as const;
export type TaxObligationOutcome = (typeof TAX_OBLIGATION_OUTCOMES)[number];

export const TAX_REVIEW_ITEM_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type TaxReviewItemStatus = (typeof TAX_REVIEW_ITEM_STATUSES)[number];

export const TAX_REVIEW_SEVERITIES = ['action_required', 'review'] as const;
export type TaxReviewSeverity = (typeof TAX_REVIEW_SEVERITIES)[number];

/** What the owner decided. None of them activates collection. */
export const TAX_REVIEW_DECISIONS = [
  'will_register',
  'registered_outside_peable',
  'not_required',
  'accepted_risk',
  'facts_corrected',
  'dismissed',
] as const;
export type TaxReviewDecision = (typeof TAX_REVIEW_DECISIONS)[number];

/** Who recorded a compliance change: the owner, a service credential, or Peable itself. */
export const TAX_ACTOR_TYPES = ['user', 'service', 'system'] as const;
export type TaxActorType = (typeof TAX_ACTOR_TYPES)[number];

export const TAX_DEADLINE_KINDS = ['return', 'payment', 'registration'] as const;
export type TaxDeadlineKind = (typeof TAX_DEADLINE_KINDS)[number];

export const TAX_DEADLINE_STATUSES = ['upcoming', 'due_soon', 'passed'] as const;
export type TaxDeadlineStatus = (typeof TAX_DEADLINE_STATUSES)[number];

export const TAX_COMPLIANCE_CAPABILITY_STATUSES = [
  'available',
  'limited',
  'not_available',
  'out_of_scope',
] as const;
export type TaxComplianceCapabilityStatus = (typeof TAX_COMPLIANCE_CAPABILITY_STATUSES)[number];

/** VAT/sales tax, corporate income tax and annual company filings are different obligations. */
export const TAX_COMPLIANCE_CAPABILITY_CATEGORIES = [
  'vat_sales_tax',
  'corporate_income_tax',
  'annual_company_filings',
  'workflow',
] as const;
export type TaxComplianceCapabilityCategory = (typeof TAX_COMPLIANCE_CAPABILITY_CATEGORIES)[number];
