import type { FileStatus } from './file';
import type { ListParams } from './list';
import type { TaxRegistrationScheme } from './tax';

/**
 * Peable Tax business compliance (ADR 0020) — the wire contract.
 *
 * What a business tells Peable about itself (its entity, where it operates,
 * where it sells, where it says it is registered and the documents behind
 * that), what Peable can work out from it against a VERSIONED rule set with
 * authoritative sources (an assessment), and what needs a person's decision
 * (the review queue). Nothing here registers, files or pays anything with a
 * government, and nothing here turns tax collection on: collection is still
 * the owner's registration plus approval (ADR 0011).
 *
 * Amounts are base-unit integer strings with an uppercase currency (ADR 0014
 * D1). Instants are Unix seconds.
 */

// ── Business onboarding ──────────────────────────────────────────────────────

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
 * The business behind a merchant. Deliberately carries NO government
 * identifier (company number, EIN): none is evidence of a tax obligation and
 * none is needed by any rule in the supported set. `legal_name` is read from
 * the tax settings, where editing it returns collection to draft.
 */
export interface TaxBusinessProfile {
  object: 'tax.business_profile';
  livemode: boolean;
  legal_name: string | null;
  entity_type: TaxLegalEntityType;
  /** ISO 3166-1 alpha-2, or null while not given. Never evidence of registration. */
  incorporation_country: string | null;
  incorporation_state: string | null;
  /** 1–12, the month the fiscal year ends in. */
  fiscal_year_end_month: number | null;
  customer_types: TaxCustomerType;
  supply_types: TaxSupplyType[];
  /** What onboarding still lacks before an assessment can be complete. */
  missing: string[];
  metadata: Record<string, string>;
  updated_by: string | null;
  updated: number | null;
}

export interface UpdateTaxBusinessProfileParams {
  entity_type?: TaxLegalEntityType;
  incorporation_country?: string | null;
  incorporation_state?: string | null;
  fiscal_year_end_month?: number | null;
  customer_types?: TaxCustomerType;
  supply_types?: TaxSupplyType[];
  metadata?: Record<string, string>;
}

/**
 * Where the business ACTUALLY operates. `head_office` and
 * `fixed_establishment` are the owner's statement of establishment (the EU
 * rule reads them); any location in a US state is physical presence there.
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

export interface TaxOperatingLocation {
  object: 'tax.operating_location';
  /** `taxol_…`. */
  id: string;
  livemode: boolean;
  kind: TaxOperatingLocationKind;
  country: string;
  state: string | null;
  description: string | null;
  started: number | null;
  /** Set once the business no longer operates there. */
  ended: number | null;
  metadata: Record<string, string>;
  created: number;
}

export interface CreateTaxOperatingLocationParams {
  kind: TaxOperatingLocationKind;
  country: string;
  state?: string | null;
  description?: string | null;
  started?: number | null;
  ended?: number | null;
  metadata?: Record<string, string>;
}
export type UpdateTaxOperatingLocationParams = Partial<
  Omit<CreateTaxOperatingLocationParams, 'kind' | 'country'>
>;

/** Where the business says it sells. Actual sales come from Peable Tax transactions. */
export interface TaxSalesDestination {
  object: 'tax.sales_destination';
  /** `taxdest_…`. */
  id: string;
  livemode: boolean;
  country: string;
  state: string | null;
  customer_types: TaxCustomerType;
  started: number | null;
  ended: number | null;
  metadata: Record<string, string>;
  created: number;
}

export interface CreateTaxSalesDestinationParams {
  country: string;
  state?: string | null;
  customer_types?: TaxCustomerType;
  started?: number | null;
  ended?: number | null;
  metadata?: Record<string, string>;
}
export type UpdateTaxSalesDestinationParams = Partial<
  Omit<CreateTaxSalesDestinationParams, 'country' | 'state'>
>;

// ── Registrations as the business declares them ──────────────────────────────

/**
 * Where the business stands with a tax authority, IN ITS OWN WORDS.
 *
 *  - `unknown` — the owner does not know; an assessment escalates it.
 *  - `not_registered` — the owner says there is no registration.
 *  - `application_pending` — an application was made outside Peable and the
 *    authority has not answered: an ambiguous outcome, never treated as
 *    registered.
 *  - `registered` — the owner says the authority registered the business,
 *    from `effective_from`.
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

/**
 * A declared registration status. Storing one in Peable is NOT registration
 * with a government, and it never makes Peable collect: collection needs a
 * Peable Tax registration (`taxreg_…`) the owner approved. `verification` is
 * always `unverified` — no authority integration confirms anything yet.
 */
export interface TaxRegistrationDeclaration {
  object: 'tax.registration_declaration';
  /** `taxrd_…`. */
  id: string;
  livemode: boolean;
  country: string;
  state: string | null;
  /** The scheme, when the owner knows it; null for `unknown`. */
  scheme: TaxRegistrationScheme | null;
  status: TaxRegistrationDeclarationStatus;
  effective_from: number | null;
  effective_to: number | null;
  filing_frequency: TaxFilingFrequency;
  /** The Peable Tax collection registration it corresponds to, when there is one. */
  collection_registration: string | null;
  verification: { status: 'unverified'; reason: 'no_authority_integration' };
  note: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export interface CreateTaxRegistrationDeclarationParams {
  country: string;
  state?: string | null;
  scheme?: TaxRegistrationScheme | null;
  status: TaxRegistrationDeclarationStatus;
  effective_from?: number | null;
  effective_to?: number | null;
  filing_frequency?: TaxFilingFrequency;
  collection_registration?: string | null;
  note?: string | null;
  metadata?: Record<string, string>;
}
export type UpdateTaxRegistrationDeclarationParams = Partial<
  Omit<CreateTaxRegistrationDeclarationParams, 'country' | 'state'>
>;

// ── Documents ────────────────────────────────────────────────────────────────

export const TAX_DOCUMENT_KINDS = [
  'registration_certificate',
  'authority_correspondence',
  'incorporation_record',
  'filing_confirmation',
  'payment_receipt',
  'other',
] as const;
export type TaxDocumentKind = (typeof TAX_DOCUMENT_KINDS)[number];

/**
 * A supporting document: a `file_…` of purpose `tax_document` (private, never
 * addressable by URL) with what it is for. Attaching a document proves
 * nothing by itself; it is what a reviewer reads.
 */
export interface TaxDocument {
  object: 'tax.document';
  /** `taxdoc_…`. */
  id: string;
  livemode: boolean;
  file: string;
  /** The file's standing now: a `removed` file is a document that is gone. */
  file_status: FileStatus;
  filename: string | null;
  kind: TaxDocumentKind;
  country: string | null;
  state: string | null;
  registration_declaration: string | null;
  description: string | null;
  metadata: Record<string, string>;
  created: number;
}

export interface CreateTaxDocumentParams {
  file: string;
  kind: TaxDocumentKind;
  country?: string | null;
  state?: string | null;
  registration_declaration?: string | null;
  description?: string | null;
  metadata?: Record<string, string>;
}

export interface TaxDocumentChecklistItem {
  key: string;
  kind: TaxDocumentKind;
  country: string | null;
  state: string | null;
  /** `provided`: an available document is attached; `unavailable`: only removed ones are. */
  status: 'provided' | 'missing' | 'unavailable';
  documents: string[];
  reason: string;
}

export interface TaxDocumentChecklist {
  object: 'tax.document_checklist';
  livemode: boolean;
  items: TaxDocumentChecklistItem[];
}

// ── The rule set ─────────────────────────────────────────────────────────────

export interface TaxRuleSource {
  title: string;
  publisher: string;
  url: string;
}

export interface TaxCoverageLimit {
  code: string;
  message: string;
}

/**
 * One supported jurisdiction rule, as versioned code. A rule names its
 * sources and when it took effect; `review.status` says whether a tax
 * professional has signed it off — an `unreviewed` rule's findings always go
 * to the review queue rather than standing on their own.
 */
export interface TaxJurisdictionRule {
  object: 'tax.jurisdiction_rule';
  /** Stable id, e.g. `eu_vat_b2c_cross_border`. */
  id: string;
  rule_set_version: string;
  name: string;
  tax_type: 'vat' | 'sales_tax';
  countries: string[];
  state: string | null;
  effective_from: number;
  threshold: {
    amount: string;
    currency: string;
    period: 'current_or_previous_calendar_year' | 'preceding_twelve_calendar_months';
  } | null;
  sources: TaxRuleSource[];
  coverage_limits: TaxCoverageLimit[];
  review: { status: 'unreviewed' | 'reviewed'; note: string };
}

export interface TaxRuleSet {
  object: 'tax.rule_set';
  version: string;
  published: number;
  rules: TaxJurisdictionRule[];
  /** Everything not listed is `unsupported`, stated rather than implied. */
  unsupported: string;
}

// ── Assessments ──────────────────────────────────────────────────────────────

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

export interface TaxAssessmentReason {
  code: string;
  message: string;
  /** The facts the reason rests on — amounts, counts, ids. Never personal data. */
  evidence: Record<string, string | number | boolean | null>;
}

export interface TaxAssessmentResult {
  /** The rule applied, or null for an unsupported jurisdiction. */
  rule: string | null;
  country: string | null;
  state: string | null;
  tax_type: 'vat' | 'sales_tax' | null;
  outcome: TaxObligationOutcome;
  reasons: TaxAssessmentReason[];
  /** Net sales measured against the threshold, when the rule has one. */
  measured: {
    amount: string;
    currency: string;
    transactions: number;
    from: number;
    to: number;
    /** Sales in other currencies: counted nowhere, named here. */
    excluded_currencies: string[];
  } | null;
  threshold: { amount: string; currency: string } | null;
  /** A deadline the rule itself sets (a Texas permit after crossing). */
  deadline: { kind: 'registration'; due: number; source: TaxRuleSource } | null;
  coverage_limits: TaxCoverageLimit[];
  /** The review items this result opened or kept open. */
  review_items: string[];
}

export interface TaxAssessment {
  object: 'tax.assessment';
  /** `taxasm_…`. */
  id: string;
  livemode: boolean;
  rule_set_version: string;
  /** The instant the facts were judged at. */
  as_of: number;
  /** SHA-256 of the canonical inputs — what a replay is checked against. */
  inputs_digest: string;
  results: TaxAssessmentResult[];
  summary: Record<TaxObligationOutcome, number>;
  created_by: { type: 'user' | 'service'; id: string | null };
  created: number;
}

export interface CreateTaxAssessmentParams {
  /** Unix seconds; default now. Never in the future. */
  as_of?: number;
}

/** Re-running a stored assessment's inputs through its own rule set version. */
export interface TaxAssessmentReplay {
  object: 'tax.assessment_replay';
  assessment: string;
  rule_set_version: string;
  inputs_digest: string;
  /** True when the replayed results are identical to the stored ones. */
  matches: boolean;
  results: TaxAssessmentResult[];
}

// ── Review queue and owner decisions ─────────────────────────────────────────

export const TAX_REVIEW_ITEM_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type TaxReviewItemStatus = (typeof TAX_REVIEW_ITEM_STATUSES)[number];

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

export interface TaxReviewItem {
  object: 'tax.review_item';
  /** `taxrev_…`. */
  id: string;
  livemode: boolean;
  /** Machine reason, e.g. `threshold_exceeded`, `registration_status_unknown`. */
  code: string;
  severity: 'action_required' | 'review';
  status: TaxReviewItemStatus;
  rule: string | null;
  country: string | null;
  state: string | null;
  message: string;
  /** The assessment that opened it, and the latest one that found it again. */
  first_assessment: string | null;
  latest_assessment: string | null;
  decision: {
    decision: TaxReviewDecision;
    note: string | null;
    decided_by: string;
    decided_at: number;
  } | null;
  created: number;
  updated: number;
}

export interface ResolveTaxReviewItemParams {
  decision: TaxReviewDecision;
  /** Required for `not_required` and `accepted_risk`: the owner's reason. */
  note?: string | null;
}

export interface ListTaxReviewItemsParams extends ListParams {
  status?: TaxReviewItemStatus;
}

// ── Action history ───────────────────────────────────────────────────────────

/** One recorded change, written in the transaction of the change itself. */
export interface TaxComplianceAction {
  object: 'tax.compliance_action';
  /** `taxact_…`. */
  id: string;
  livemode: boolean;
  /** e.g. `business_profile.updated`, `review_item.resolved`. */
  action: string;
  actor: { type: 'user' | 'service' | 'system'; id: string | null };
  object_type: string;
  object_id: string | null;
  /** Field names and statuses that changed — never the values of a document or a number. */
  details: Record<string, string | number | boolean | null>;
  created: number;
}

// ── Deadlines and capabilities ───────────────────────────────────────────────

/**
 * A due date the rule set can compute. `filing_status` is `not_tracked`:
 * Peable files nothing, so it never claims a return was or was not filed.
 */
export interface TaxDeadline {
  object: 'tax.deadline';
  kind: 'return' | 'payment' | 'registration';
  rule: string;
  country: string | null;
  state: string | null;
  period_start: number | null;
  period_end: number | null;
  due: number;
  status: 'upcoming' | 'due_soon' | 'passed';
  filing_status: 'not_tracked';
  description: string;
  source: TaxRuleSource;
}

export interface TaxDeadlineUnavailable {
  rule: string | null;
  country: string | null;
  state: string | null;
  reason: string;
}

export interface TaxDeadlineList {
  object: 'list';
  data: TaxDeadline[];
  has_more: false;
  url: string;
  /** Where a deadline exists but the rule set cannot compute it, and why. */
  unavailable: TaxDeadlineUnavailable[];
}

export const TAX_COMPLIANCE_CAPABILITY_STATUSES = [
  'available',
  'limited',
  'not_available',
  'out_of_scope',
] as const;
export type TaxComplianceCapabilityStatus = (typeof TAX_COMPLIANCE_CAPABILITY_STATUSES)[number];

export interface TaxComplianceCapability {
  id: string;
  /** VAT/sales tax, corporate income tax and annual company filings are different obligations. */
  category: 'vat_sales_tax' | 'corporate_income_tax' | 'annual_company_filings' | 'workflow';
  status: TaxComplianceCapabilityStatus;
  reason: string;
}

export interface TaxComplianceCapabilities {
  object: 'tax.compliance_capabilities';
  livemode: boolean;
  rule_set_version: string;
  supported_rules: string[];
  capabilities: TaxComplianceCapability[];
}
