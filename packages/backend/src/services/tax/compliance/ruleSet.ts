/**
 * The jurisdiction rule set (ADR 0020) — versioned CODE, not data a request
 * can change.
 *
 * A version is immutable once published: an assessment stores the version it
 * ran under and its exact inputs, and `replay` re-runs those inputs through
 * the SAME version. Changing a threshold, a source or what a rule counts is a
 * new version beside the old one, never an edit — otherwise a stored
 * assessment could no longer be explained by the rules it names.
 *
 * Only the rules listed here are supported. Every other jurisdiction is
 * `unsupported`, stated as such in every assessment rather than guessed.
 *
 * Every rule is `review.status: 'unreviewed'`: the sources are official, the
 * encoding has not been signed off by a tax professional. Until it is, every
 * finding of a rule goes to the review queue for a person to decide.
 */
import type {
  TaxCoverageLimit,
  TaxJurisdictionRule,
  TaxRuleSet,
  TaxRuleSource,
} from '@peable.to/shared-types';
import { EU_MEMBER_STATES } from '../jurisdictions';

export const EU_VAT_RULE = 'eu_vat_b2c_cross_border';
export const US_TX_RULE = 'us_tx_sales_tax';

export const SOURCES = {
  euOss: {
    title: 'One Stop Shop (OSS): the EUR 10 000 threshold and the Union and non-Union schemes',
    publisher: 'European Commission',
    url: 'https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en',
  },
  euOssReturns: {
    title: 'OSS: declare and pay — tax period and return deadline',
    publisher: 'European Commission',
    url: 'https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en',
  },
  euDirective: {
    title: 'Council Directive 2006/112/EC (consolidated), Articles 59c, 358a–369k',
    publisher: 'EUR-Lex',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02006L0112-20220415',
  },
  // The page states the safe harbor of 34 Tex. Admin. Code §3.286 and links
  // the rule itself.
  txRemoteSellers: {
    title:
      'Remote Sellers — the §3.286 safe harbor, what counts as Texas revenue, and permit timing',
    publisher: 'Texas Comptroller of Public Accounts',
    url: 'https://comptroller.texas.gov/taxes/sales/remote-sellers.php',
  },
} as const satisfies Record<string, TaxRuleSource>;

/** What every rule shares: what Peable can see, and what it cannot. */
const SHARED_LIMITS: readonly TaxCoverageLimit[] = [
  {
    code: 'peable_sales_only',
    message:
      'Only sales recorded as Peable Tax transactions are measured. Sales made outside Peable are invisible to this assessment.',
  },
  {
    code: 'no_marketplace_rules',
    message: 'Marketplace and deemed-supplier rules are not assessed.',
  },
];

/** Rule internals the evaluator reads; the wire rule is derived from them. */
export interface RuleDefinition {
  readonly id: string;
  readonly name: string;
  readonly taxType: 'vat' | 'sales_tax';
  readonly countries: readonly string[];
  readonly state: string | null;
  readonly effectiveFrom: string;
  /** Minor units of `currency`. */
  readonly thresholdMinor: bigint | null;
  readonly currency: string;
  readonly period: 'current_or_previous_calendar_year' | 'preceding_twelve_calendar_months';
  /** Fraction of the threshold at which `approaching_threshold` is reported, in percent. */
  readonly approachingPercent: number;
  readonly sources: readonly TaxRuleSource[];
  readonly coverageLimits: readonly TaxCoverageLimit[];
}

export interface RuleSetDefinition {
  readonly version: string;
  readonly published: string;
  readonly rules: readonly RuleDefinition[];
}

const EU_COUNTRIES = [...EU_MEMBER_STATES].sort();

/** Version 2026-11-03.1 — the initial supported set. */
const V2026_11_03_1: RuleSetDefinition = {
  version: '2026-11-03.1',
  published: '2026-11-03T00:00:00Z',
  rules: [
    {
      id: EU_VAT_RULE,
      name: 'EU VAT on cross-border B2C electronic services and distance sales (OSS)',
      taxType: 'vat',
      countries: EU_COUNTRIES,
      state: null,
      effectiveFrom: '2021-07-01T00:00:00Z',
      // EUR 10 000 without VAT, current or preceding calendar year (Art. 59c).
      thresholdMinor: 1_000_000n,
      currency: 'EUR',
      period: 'current_or_previous_calendar_year',
      approachingPercent: 80,
      sources: [SOURCES.euOss, SOURCES.euOssReturns, SOURCES.euDirective],
      coverageLimits: [
        ...SHARED_LIMITS,
        {
          code: 'b2b_not_separated',
          message:
            'Business customers cannot be told apart from consumers, so every sale is counted as B2C — an over-count, never an under-count.',
        },
        {
          code: 'supply_type_not_separated',
          message:
            'Every recorded sale is treated as an electronic service or distance sale; other supplies are not distinguished.',
        },
        {
          code: 'eur_only',
          message:
            'Only EUR sales are counted toward the EUR threshold; sales in other currencies are named, not converted.',
        },
        {
          code: 'domestic_vat_not_assessed',
          message:
            'VAT in the member state where the business is established, and the opt-out of Art. 59c(3), are not assessed.',
        },
      ],
    },
    {
      id: US_TX_RULE,
      name: 'Texas sales and use tax — remote seller safe harbor',
      taxType: 'sales_tax',
      countries: ['US'],
      state: 'TX',
      effectiveFrom: '2019-10-01T00:00:00Z',
      // USD 500 000 total Texas revenue, preceding twelve calendar months.
      thresholdMinor: 50_000_000n,
      currency: 'USD',
      period: 'preceding_twelve_calendar_months',
      approachingPercent: 80,
      sources: [SOURCES.txRemoteSellers],
      coverageLimits: [
        ...SHARED_LIMITS,
        {
          code: 'net_of_tax',
          message:
            'Revenue is measured net of tax collected; separately stated handling or shipping fees outside Peable Tax are not included.',
        },
        {
          code: 'usd_only',
          message:
            'Only USD sales are counted; sales in other currencies are named, not converted.',
        },
        {
          code: 'return_due_dates_not_computed',
          message:
            'Return due dates depend on the filing frequency the Comptroller assigns and are not computed.',
        },
        {
          code: 'franchise_tax_not_assessed',
          message:
            'Texas franchise tax (an entity-level tax with its own nexus test) is not assessed.',
        },
      ],
    },
  ],
};

const RULE_SETS: ReadonlyMap<string, RuleSetDefinition> = new Map([
  [V2026_11_03_1.version, V2026_11_03_1],
]);

/** The version new assessments run under. */
export const CURRENT_RULE_SET_VERSION = V2026_11_03_1.version;

export function ruleSetByVersion(version: string): RuleSetDefinition | undefined {
  return RULE_SETS.get(version);
}

export function currentRuleSet(): RuleSetDefinition {
  const current = RULE_SETS.get(CURRENT_RULE_SET_VERSION);
  if (!current) throw new Error('the current rule set version is not registered');
  return current;
}

const UNREVIEWED_NOTE =
  'Encoded from the official sources listed; not yet signed off by a tax professional. Findings go to the review queue.';

export function ruleDto(rule: RuleDefinition, version: string): TaxJurisdictionRule {
  return {
    object: 'tax.jurisdiction_rule',
    id: rule.id,
    rule_set_version: version,
    name: rule.name,
    tax_type: rule.taxType,
    countries: [...rule.countries],
    state: rule.state,
    effective_from: Math.floor(Date.parse(rule.effectiveFrom) / 1000),
    threshold:
      rule.thresholdMinor === null
        ? null
        : { amount: rule.thresholdMinor.toString(), currency: rule.currency, period: rule.period },
    sources: [...rule.sources],
    coverage_limits: [...rule.coverageLimits],
    review: { status: 'unreviewed', note: UNREVIEWED_NOTE },
  };
}

export function ruleSetDto(definition: RuleSetDefinition): TaxRuleSet {
  return {
    object: 'tax.rule_set',
    version: definition.version,
    published: Math.floor(Date.parse(definition.published) / 1000),
    rules: definition.rules.map((rule) => ruleDto(rule, definition.version)),
    unsupported:
      'Every jurisdiction not listed is unsupported: Peable reports sales there and opens a review item, and never infers an obligation.',
  };
}

/** The rule covering a destination, if one does. */
export function ruleFor(
  definition: RuleSetDefinition,
  country: string,
  state: string | null,
): RuleDefinition | undefined {
  return definition.rules.find(
    (rule) => rule.countries.includes(country) && (rule.state === null || rule.state === state),
  );
}
