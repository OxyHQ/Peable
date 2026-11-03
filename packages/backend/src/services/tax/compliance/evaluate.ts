/**
 * Obligation assessment v1 (ADR 0020) — a PURE function of its inputs and a
 * rule set version, so a stored assessment can be replayed exactly.
 *
 * It reads only what the owner declared and what Peable Tax recorded. It never
 * treats an incorporation country, a company number, a language or a currency
 * as evidence of registration or liability: the business profile is not an
 * input to any rule. And it never decides anything: a finding is a review item
 * for a person, and collection stays off until the owner turns it on through
 * the ADR 0011 approval.
 */
import type {
  TaxAssessmentReason,
  TaxAssessmentResult,
  TaxCoverageLimit,
  TaxObligationOutcome,
  TaxOperatingLocationKind,
  TaxRegistrationDeclarationStatus,
  TaxRegistrationScheme,
} from '@peable.to/shared-types';
import {
  EU_VAT_RULE,
  type RuleDefinition,
  type RuleSetDefinition,
  ruleFor,
  SOURCES,
  US_TX_RULE,
} from './ruleSet';

/** Everything an assessment judged — stored verbatim, digested, replayed. */
export interface AssessmentInputs {
  readonly rule_set_version: string;
  /** ISO-8601 UTC. */
  readonly as_of: string;
  readonly locations: readonly {
    readonly id: string;
    readonly kind: TaxOperatingLocationKind;
    readonly country: string;
    readonly state: string | null;
    readonly started: string | null;
    readonly ended: string | null;
  }[];
  readonly destinations: readonly {
    readonly id: string;
    readonly country: string;
    readonly state: string | null;
    readonly started: string | null;
    readonly ended: string | null;
  }[];
  readonly declarations: readonly {
    readonly id: string;
    readonly country: string;
    readonly state: string | null;
    readonly scheme: TaxRegistrationScheme | null;
    readonly status: TaxRegistrationDeclarationStatus;
    readonly effective_from: string | null;
    readonly effective_to: string | null;
  }[];
  /** The owner's APPROVED Peable Tax registrations — what Peable collects under. */
  readonly collection_registrations: readonly {
    readonly id: string;
    readonly country: string;
    readonly state: string | null;
    readonly scheme: TaxRegistrationScheme;
    readonly active_from: string;
    readonly expires_at: string | null;
  }[];
  /** Net sales per destination, currency and UTC month, from Peable Tax transactions. */
  readonly sales: readonly {
    readonly country: string;
    readonly state: string | null;
    readonly currency: string;
    /** `YYYY-MM`. */
    readonly month: string;
    /** Minor units, net of tax, reversals netted. */
    readonly net_minor: string;
    readonly transactions: number;
  }[];
}

/** A finding that needs a person: becomes (or keeps) an open review item. */
export interface ReviewFinding {
  readonly dedupeKey: string;
  readonly code: string;
  readonly severity: 'action_required' | 'review';
  readonly rule: string | null;
  readonly country: string | null;
  readonly state: string | null;
  readonly message: string;
}

export interface EvaluatedResult {
  readonly result: Omit<TaxAssessmentResult, 'review_items'>;
  readonly findings: readonly ReviewFinding[];
}

const SECOND = 1000;
const unix = (iso: string) => Math.floor(Date.parse(iso) / SECOND);
const monthIndex = (date: Date) => date.getUTCFullYear() * 12 + date.getUTCMonth();
const monthKey = (index: number) =>
  `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
const monthStart = (index: number) => new Date(Date.UTC(Math.floor(index / 12), index % 12, 1));
const parseMonth = (key: string) => {
  const [year, month] = key.split('-').map(Number);
  return (year ?? 0) * 12 + ((month ?? 1) - 1);
};

function inForce(at: Date, started: string | null, ended: string | null): boolean {
  return (!started || Date.parse(started) <= +at) && (!ended || Date.parse(ended) > +at);
}

const ESTABLISHMENT_KINDS: ReadonlySet<TaxOperatingLocationKind> = new Set([
  'head_office',
  'fixed_establishment',
]);
const OSS_SCHEMES: ReadonlySet<string> = new Set(['eu_oss_union', 'eu_oss_non_union']);

const ACTION_REQUIRED: ReadonlySet<string> = new Set([
  'threshold_exceeded',
  'registration_likely_required',
  'physical_presence',
  'collection_not_configured',
  'establishment_unknown',
  'sales_after_registration_ended',
]);

const MESSAGES: Record<string, string> = {
  threshold_exceeded:
    'Recorded sales are above the threshold of a supported rule. Decide whether to register with the authority; Peable will not register or collect on its own.',
  threshold_approaching: 'Recorded sales are at or above 80% of the threshold.',
  registration_likely_required:
    'The rule indicates registration from the first sale and sales are recorded. Decide whether to register with the authority.',
  physical_presence:
    'A declared operating location is in this jurisdiction, so the remote-seller safe harbor does not apply. A person must assess the obligation.',
  establishment_unknown:
    'No head office or fixed establishment is declared, so the rule cannot tell which threshold applies. Record where the business is established.',
  establishment_ambiguous:
    'Establishments are declared in more than one place, or both inside and outside the EU; the threshold rule cannot be applied without review.',
  possible_fixed_establishment:
    'A declared location in the EU could be a fixed establishment. Confirm its kind.',
  registration_status_unknown:
    'The registration status here is recorded as unknown. Find out and record it.',
  application_pending:
    'An application is recorded as pending with the authority. It is not treated as a registration until the authority confirms it.',
  sales_after_registration_ended:
    'Sales are recorded in or after the month the declared registration ended (sales are measured per calendar month).',
  collection_not_configured:
    'A registration is declared here, but Peable is not collecting under an approved Peable Tax registration. Collection turns on only when the owner adds and approves one.',
  collection_without_declared_registration:
    'Peable collects here under an approved registration, but no registration with the authority is declared, or the declared one has ended.',
  unconverted_sales:
    'Sales in other currencies were not converted and are not counted toward the threshold.',
  unsupported_jurisdiction_sales:
    'Sales are recorded where no supported rule applies. Peable does not assess this jurisdiction; a person must.',
};

function finding(
  rule: string | null,
  country: string | null,
  state: string | null,
  code: string,
): ReviewFinding {
  return {
    dedupeKey: `${rule ?? 'unsupported'}:${country ?? ''}:${state ?? ''}:${code}`,
    code,
    severity: ACTION_REQUIRED.has(code) ? 'action_required' : 'review',
    rule,
    country,
    state,
    message: MESSAGES[code] ?? code,
  };
}

const reason = (
  code: string,
  message: string,
  evidence: TaxAssessmentReason['evidence'] = {},
): TaxAssessmentReason => ({ code, message, evidence });

/** Sum net minor units of `rows` per currency, with the transaction count. */
function totals(rows: AssessmentInputs['sales']) {
  const out = new Map<string, { net: bigint; transactions: number }>();
  for (const row of rows) {
    const current = out.get(row.currency) ?? { net: 0n, transactions: 0 };
    current.net += BigInt(row.net_minor);
    current.transactions += row.transactions;
    out.set(row.currency, current);
  }
  return out;
}

/** Declarations about this rule's jurisdiction, judged at `at`. */
function declarationsFor(inputs: AssessmentInputs, rule: RuleDefinition, at: Date) {
  const mine = inputs.declarations.filter(
    (row) =>
      rule.countries.includes(row.country) && (rule.state === null || row.state === rule.state),
  );
  const covers = (row: (typeof mine)[number]) =>
    rule.id === EU_VAT_RULE ? OSS_SCHEMES.has(row.scheme ?? '') : true;
  const registered = mine.filter(
    (row) =>
      row.status === 'registered' &&
      covers(row) &&
      inForce(at, row.effective_from, row.effective_to),
  );
  const ended = mine.filter(
    (row) =>
      covers(row) &&
      (row.status === 'ended' || row.status === 'registered') &&
      row.effective_to !== null &&
      Date.parse(row.effective_to) <= +at,
  );
  return {
    registered,
    ended,
    unknown: mine.filter((row) => row.status === 'unknown'),
    pending: mine.filter((row) => row.status === 'application_pending'),
  };
}

function collectsUnder(inputs: AssessmentInputs, rule: RuleDefinition, at: Date): boolean {
  return inputs.collection_registrations.some(
    (row) =>
      inForce(at, row.active_from, row.expires_at) &&
      (rule.id === EU_VAT_RULE
        ? OSS_SCHEMES.has(row.scheme)
        : row.country === rule.countries[0] && row.state === rule.state),
  );
}

/** The parts every supported rule shares: declarations, collection, ended registrations. */
function declaredState(
  inputs: AssessmentInputs,
  rule: RuleDefinition,
  at: Date,
  sales: AssessmentInputs['sales'],
  reasons: TaxAssessmentReason[],
  findings: ReviewFinding[],
) {
  const country = rule.state ? (rule.countries[0] ?? null) : null;
  const add = (code: string) => findings.push(finding(rule.id, country, rule.state, code));
  const declared = declarationsFor(inputs, rule, at);
  for (const row of declared.unknown) {
    reasons.push(
      reason('registration_status_unknown', MESSAGES.registration_status_unknown ?? '', {
        declaration: row.id,
        country: row.country,
      }),
    );
  }
  if (declared.unknown.length) add('registration_status_unknown');
  for (const row of declared.pending) {
    reasons.push(
      reason('application_pending', MESSAGES.application_pending ?? '', {
        declaration: row.id,
        country: row.country,
      }),
    );
  }
  if (declared.pending.length) add('application_pending');
  const endedWithSales = declared.ended.filter((row) => {
    const endMonth = monthIndex(new Date(row.effective_to ?? 0));
    return sales.some((sale) => parseMonth(sale.month) >= endMonth && sale.transactions > 0);
  });
  for (const row of endedWithSales) {
    reasons.push(
      reason('sales_after_registration_ended', MESSAGES.sales_after_registration_ended ?? '', {
        declaration: row.id,
        ended: row.effective_to ? unix(row.effective_to) : null,
      }),
    );
  }
  if (endedWithSales.length) add('sales_after_registration_ended');
  const collecting = collectsUnder(inputs, rule, at);
  if (declared.registered.length && !collecting) add('collection_not_configured');
  return { declared, collecting };
}

function evaluateEu(inputs: AssessmentInputs, rule: RuleDefinition, at: Date): EvaluatedResult {
  const reasons: TaxAssessmentReason[] = [];
  const findings: ReviewFinding[] = [];
  const add = (code: string) => findings.push(finding(rule.id, null, null, code));
  const euSales = inputs.sales.filter((row) => rule.countries.includes(row.country));
  const { declared, collecting } = declaredState(inputs, rule, at, euSales, reasons, findings);

  const locations = inputs.locations.filter((row) => inForce(at, row.started, row.ended));
  const establishments = locations.filter((row) => ESTABLISHMENT_KINDS.has(row.kind));
  const euEstablishments = establishments.filter((row) => rule.countries.includes(row.country));
  const elsewhere = establishments.filter((row) => !rule.countries.includes(row.country));
  const euPresence = locations.filter(
    (row) => !ESTABLISHMENT_KINDS.has(row.kind) && rule.countries.includes(row.country),
  );
  const euDestinations = inputs.destinations.filter(
    (row) => rule.countries.includes(row.country) && inForce(at, row.started, row.ended),
  );
  const establishedIn = new Set(euEstablishments.map((row) => row.country));

  const year = at.getUTCFullYear();
  const yearSales = (y: number) =>
    euSales.filter(
      (row) =>
        row.month.startsWith(`${y}-`) &&
        !(establishedIn.size === 1 && establishedIn.has(row.country)),
    );
  const current = totals(yearSales(year));
  const previous = totals(yearSales(year - 1));
  const eurCurrent = current.get(rule.currency) ?? { net: 0n, transactions: 0 };
  const eurPrevious = previous.get(rule.currency) ?? { net: 0n, transactions: 0 };
  const excluded = [...new Set([...current.keys(), ...previous.keys()])]
    .filter((currency) => currency !== rule.currency)
    .sort();
  const measuredYear = eurPrevious.net > eurCurrent.net ? year - 1 : year;
  const measuredTotal = measuredYear === year ? eurCurrent : eurPrevious;
  const measured = {
    amount: measuredTotal.net.toString(),
    currency: rule.currency,
    transactions: measuredTotal.transactions,
    from: Math.floor(Date.UTC(measuredYear, 0, 1) / SECOND),
    to:
      measuredYear === year
        ? Math.floor(+at / SECOND)
        : Math.floor(Date.UTC(measuredYear + 1, 0, 1) / SECOND),
    excluded_currencies: excluded,
  };
  const threshold = rule.thresholdMinor ?? 0n;
  const anyEuSales = euSales.some((row) => row.transactions > 0);
  let outcome: TaxObligationOutcome;

  if (declared.registered.length) {
    outcome = 'registration_declared';
    reasons.push(
      reason(
        'registration_declared',
        'The owner declares an OSS registration in force. Peable has not verified it with any authority.',
        { declaration: declared.registered[0]?.id ?? null, collecting },
      ),
    );
  } else if (!establishments.length) {
    if (anyEuSales || euDestinations.length) {
      outcome = 'uncertain';
      add('establishment_unknown');
      reasons.push(reason('establishment_unknown', MESSAGES.establishment_unknown ?? ''));
    } else {
      outcome = 'not_indicated';
      reasons.push(
        reason('no_eu_activity', 'No EU sales are recorded and no EU destination is declared.'),
      );
    }
  } else if (establishedIn.size > 1 || (establishedIn.size && elsewhere.length)) {
    outcome = 'uncertain';
    add('establishment_ambiguous');
    reasons.push(
      reason('establishment_ambiguous', MESSAGES.establishment_ambiguous ?? '', {
        eu_establishments: establishedIn.size,
        other_establishments: elsewhere.length,
      }),
    );
  } else if (!establishedIn.size) {
    // Established only outside the EU: Art. 59c's threshold is for a supplier
    // established in ONE member state; a non-EU supplier owes VAT where the
    // consumer is from the first sale (non-Union scheme).
    if (anyEuSales) {
      outcome = 'likely_required';
      add('registration_likely_required');
      reasons.push(
        reason(
          'non_eu_supplier_no_threshold',
          'The business declares establishment only outside the EU; the EUR 10 000 threshold does not apply and VAT is due where the consumer is from the first sale.',
          { eu_transactions: euSales.reduce((sum, row) => sum + row.transactions, 0) },
        ),
      );
    } else {
      outcome = 'not_indicated';
      reasons.push(
        reason(
          'non_eu_supplier_no_sales',
          euDestinations.length
            ? 'No EU sales are recorded yet. For a supplier established outside the EU, VAT on B2C electronic services is due from the first sale.'
            : 'No EU sales are recorded and no EU destination is declared.',
          { declared_destinations: euDestinations.length },
        ),
      );
    }
  } else if (measuredTotal.net > threshold) {
    outcome = 'likely_required';
    add('threshold_exceeded');
    reasons.push(
      reason('threshold_exceeded', MESSAGES.threshold_exceeded ?? '', {
        measured_year: measuredYear,
        current_year_minor: eurCurrent.net.toString(),
        previous_year_minor: eurPrevious.net.toString(),
        threshold_minor: threshold.toString(),
      }),
    );
  } else if (measuredTotal.net * 100n >= threshold * BigInt(rule.approachingPercent)) {
    outcome = 'approaching_threshold';
    reasons.push(
      reason('threshold_approaching', MESSAGES.threshold_approaching ?? '', {
        current_year_minor: eurCurrent.net.toString(),
        previous_year_minor: eurPrevious.net.toString(),
        threshold_minor: threshold.toString(),
      }),
    );
  } else {
    outcome = 'not_indicated';
    reasons.push(
      reason('below_threshold', 'Cross-border EU sales are below the EUR 10 000 threshold.', {
        current_year_minor: eurCurrent.net.toString(),
        previous_year_minor: eurPrevious.net.toString(),
        threshold_minor: threshold.toString(),
      }),
    );
  }

  if (euPresence.length && outcome !== 'registration_declared') {
    add('possible_fixed_establishment');
    reasons.push(
      reason('possible_fixed_establishment', MESSAGES.possible_fixed_establishment ?? '', {
        locations: euPresence.length,
      }),
    );
  }
  if (excluded.length) {
    reasons.push(
      reason('unconverted_sales', MESSAGES.unconverted_sales ?? '', {
        currencies: excluded.join(','),
      }),
    );
    if (outcome === 'not_indicated' || outcome === 'approaching_threshold') {
      outcome = 'uncertain';
      add('unconverted_sales');
    }
  }
  if (declared.unknown.length && outcome === 'not_indicated') outcome = 'uncertain';

  return {
    result: {
      rule: rule.id,
      country: null,
      state: null,
      tax_type: rule.taxType,
      outcome,
      reasons,
      measured,
      threshold: { amount: threshold.toString(), currency: rule.currency },
      deadline: null,
      coverage_limits: [...rule.coverageLimits],
    },
    findings,
  };
}

function evaluateTx(inputs: AssessmentInputs, rule: RuleDefinition, at: Date): EvaluatedResult {
  const reasons: TaxAssessmentReason[] = [];
  const findings: ReviewFinding[] = [];
  const country = rule.countries[0] ?? 'US';
  const add = (code: string) => findings.push(finding(rule.id, country, rule.state, code));
  const sales = inputs.sales.filter((row) => row.country === country && row.state === rule.state);
  const { declared, collecting } = declaredState(inputs, rule, at, sales, reasons, findings);
  const presence = inputs.locations.filter(
    (row) =>
      row.country === country && row.state === rule.state && inForce(at, row.started, row.ended),
  );
  const threshold = rule.thresholdMinor ?? 0n;
  const asOfMonth = monthIndex(at);
  /** Net USD over the twelve calendar months ending with month `end`. */
  const window = (end: number) => {
    const rows = sales.filter((row) => {
      const m = parseMonth(row.month);
      return m <= end && m > end - 12;
    });
    return totals(rows);
  };
  const latest = window(asOfMonth - 1);
  const usd = latest.get(rule.currency) ?? { net: 0n, transactions: 0 };
  const excluded = [...latest.keys()].filter((currency) => currency !== rule.currency).sort();
  const measured = {
    amount: usd.net.toString(),
    currency: rule.currency,
    transactions: usd.transactions,
    from: Math.floor(+monthStart(asOfMonth - 12) / SECOND),
    to: Math.floor(+monthStart(asOfMonth) / SECOND),
    excluded_currencies: excluded,
  };
  // The earliest of the last twelve windows that crossed: the permit is due
  // by the first day of the fourth month after it (Comptroller, Remote Sellers).
  let crossed: number | null = null;
  for (let end = asOfMonth - 12; end <= asOfMonth - 1; end += 1) {
    if ((window(end).get(rule.currency)?.net ?? 0n) >= threshold) {
      crossed = end;
      break;
    }
  }
  let outcome: TaxObligationOutcome;
  let deadline: TaxAssessmentResult['deadline'] = null;
  if (declared.registered.length) {
    outcome = 'registration_declared';
    reasons.push(
      reason(
        'registration_declared',
        'The owner declares a Texas sales tax permit in force. Peable has not verified it with the Comptroller.',
        { declaration: declared.registered[0]?.id ?? null, collecting },
      ),
    );
  } else if (presence.length) {
    outcome = 'uncertain';
    add('physical_presence');
    reasons.push(
      reason('physical_presence', MESSAGES.physical_presence ?? '', { locations: presence.length }),
    );
  } else if (crossed !== null) {
    outcome = 'likely_required';
    add('threshold_exceeded');
    deadline = {
      kind: 'registration',
      due: Math.floor(+monthStart(crossed + 4) / SECOND),
      source: SOURCES.txRemoteSellers,
    };
    reasons.push(
      reason('threshold_exceeded', MESSAGES.threshold_exceeded ?? '', {
        window_end_month: monthKey(crossed),
        measured_minor: (window(crossed).get(rule.currency)?.net ?? 0n).toString(),
        threshold_minor: threshold.toString(),
        earliest_window_checked: crossed === asOfMonth - 12,
      }),
    );
  } else if (usd.net * 100n >= threshold * BigInt(rule.approachingPercent)) {
    outcome = 'approaching_threshold';
    reasons.push(
      reason('threshold_approaching', MESSAGES.threshold_approaching ?? '', {
        measured_minor: usd.net.toString(),
        threshold_minor: threshold.toString(),
      }),
    );
  } else {
    outcome = 'not_indicated';
    reasons.push(
      reason(
        'below_threshold',
        'Texas revenue in the preceding twelve calendar months is below USD 500 000.',
        {
          measured_minor: usd.net.toString(),
          threshold_minor: threshold.toString(),
        },
      ),
    );
  }
  if (excluded.length) {
    reasons.push(
      reason('unconverted_sales', MESSAGES.unconverted_sales ?? '', {
        currencies: excluded.join(','),
      }),
    );
    if (outcome === 'not_indicated' || outcome === 'approaching_threshold') {
      outcome = 'uncertain';
      add('unconverted_sales');
    }
  }
  if (declared.unknown.length && outcome === 'not_indicated') outcome = 'uncertain';
  return {
    result: {
      rule: rule.id,
      country,
      state: rule.state,
      tax_type: rule.taxType,
      outcome,
      reasons,
      measured,
      threshold: { amount: threshold.toString(), currency: rule.currency },
      deadline,
      coverage_limits: [...rule.coverageLimits],
    },
    findings,
  };
}

const UNSUPPORTED_LIMIT: TaxCoverageLimit = {
  code: 'jurisdiction_unsupported',
  message:
    'No rule in this rule set version covers this jurisdiction. Nothing is inferred about an obligation here.',
};

/** Sales or declared destinations where no rule applies: shown, never guessed. */
function evaluateUnsupported(
  inputs: AssessmentInputs,
  definition: RuleSetDefinition,
  at: Date,
): EvaluatedResult[] {
  const places = new Map<string, { country: string; state: string | null }>();
  const key = (country: string, state: string | null) => `${country}:${state ?? ''}`;
  for (const row of inputs.sales)
    if (!ruleFor(definition, row.country, row.state)) places.set(key(row.country, row.state), row);
  for (const row of inputs.destinations)
    if (inForce(at, row.started, row.ended) && !ruleFor(definition, row.country, row.state))
      places.set(key(row.country, row.state), row);
  return [...places.values()]
    .sort(
      (a, b) => a.country.localeCompare(b.country) || (a.state ?? '').localeCompare(b.state ?? ''),
    )
    .map(({ country, state }) => {
      const sold = totals(
        inputs.sales.filter((row) => row.country === country && row.state === state),
      );
      const evidence: TaxAssessmentReason['evidence'] = {};
      let transactions = 0;
      for (const [currency, total] of [...sold.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        evidence[`net_minor_${currency}`] = total.net.toString();
        transactions += total.transactions;
      }
      evidence.transactions = transactions;
      const findings = transactions
        ? [finding(null, country, state, 'unsupported_jurisdiction_sales')]
        : [];
      return {
        result: {
          rule: null,
          country,
          state,
          tax_type: null,
          outcome: 'unsupported' as const,
          reasons: [
            reason(
              transactions ? 'unsupported_jurisdiction_sales' : 'declared_destination',
              transactions
                ? (MESSAGES.unsupported_jurisdiction_sales ?? '')
                : 'A declared sales destination with no supported rule. Nothing is assessed here.',
              evidence,
            ),
          ],
          measured: null,
          threshold: null,
          deadline: null,
          coverage_limits: [UNSUPPORTED_LIMIT],
        },
        findings,
      };
    });
}

/** Approved Peable Tax collection with no declared authority registration behind it. */
function collectionFindings(inputs: AssessmentInputs, at: Date): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const row of inputs.collection_registrations) {
    if (!inForce(at, row.active_from, row.expires_at)) continue;
    const oss = OSS_SCHEMES.has(row.scheme);
    const matching = inputs.declarations.filter((declaration) =>
      oss
        ? OSS_SCHEMES.has(declaration.scheme ?? '')
        : declaration.country === row.country && declaration.state === row.state,
    );
    const standing = matching.some(
      (declaration) =>
        declaration.status === 'registered' &&
        inForce(at, declaration.effective_from, declaration.effective_to),
    );
    if (!standing) {
      out.push(
        finding(
          oss ? EU_VAT_RULE : null,
          oss ? null : row.country,
          oss ? null : row.state,
          'collection_without_declared_registration',
        ),
      );
    }
  }
  return out;
}

export function evaluate(
  inputs: AssessmentInputs,
  definition: RuleSetDefinition,
): EvaluatedResult[] {
  const at = new Date(inputs.as_of);
  const evaluated: EvaluatedResult[] = [];
  for (const rule of definition.rules) {
    if (Date.parse(rule.effectiveFrom) > +at) continue;
    if (rule.id === EU_VAT_RULE) evaluated.push(evaluateEu(inputs, rule, at));
    else if (rule.id === US_TX_RULE) evaluated.push(evaluateTx(inputs, rule, at));
  }
  evaluated.push(...evaluateUnsupported(inputs, definition, at));
  // Collection findings join the result of their jurisdiction.
  for (const extra of collectionFindings(inputs, at)) {
    const target = evaluated.find(
      (each) =>
        (extra.rule !== null && each.result.rule === extra.rule) ||
        (extra.rule === null &&
          each.result.country === extra.country &&
          each.result.state === extra.state),
    );
    if (target) (target.findings as ReviewFinding[]).push(extra);
    else {
      const supported = ruleFor(definition, extra.country ?? '', extra.state);
      const placed = supported
        ? evaluated.find((each) => each.result.rule === supported.id)
        : undefined;
      if (placed)
        (placed.findings as ReviewFinding[]).push({ ...extra, rule: supported?.id ?? null });
      else
        evaluated.push({
          result: {
            rule: null,
            country: extra.country,
            state: extra.state,
            tax_type: null,
            outcome: 'unsupported',
            reasons: [
              reason(
                'collection_configured',
                MESSAGES.collection_without_declared_registration ?? '',
              ),
            ],
            measured: null,
            threshold: null,
            deadline: null,
            coverage_limits: [UNSUPPORTED_LIMIT],
          },
          findings: [extra],
        });
    }
  }
  // One finding per dedupe key per result.
  return evaluated.map((each) => ({
    result: each.result,
    findings: [...new Map(each.findings.map((item) => [item.dedupeKey, item])).values()],
  }));
}

export function summarize(
  results: readonly { outcome: TaxObligationOutcome }[],
): Record<TaxObligationOutcome, number> {
  const summary: Record<TaxObligationOutcome, number> = {
    registration_declared: 0,
    likely_required: 0,
    approaching_threshold: 0,
    not_indicated: 0,
    uncertain: 0,
    unsupported: 0,
  };
  for (const result of results) summary[result.outcome] += 1;
  return summary;
}

/** The first month the stored sales must cover for `asOf`: two full years back. */
export function salesWindowStart(asOf: Date): Date {
  return new Date(
    Math.min(+monthStart(monthIndex(asOf) - 24), Date.UTC(asOf.getUTCFullYear() - 1, 0, 1)),
  );
}

export { monthKey, monthIndex, monthStart };
