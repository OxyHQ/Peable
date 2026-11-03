import { describe, expect, test } from 'bun:test';
import { type AssessmentInputs, evaluate, salesWindowStart } from '../evaluate';
import { currentRuleSet, EU_VAT_RULE, ruleSetByVersion, ruleSetDto, US_TX_RULE } from '../ruleSet';

/** Synthetic facts only — no real company, number or customer anywhere. */
const base = (over: Partial<AssessmentInputs> = {}): AssessmentInputs => ({
  rule_set_version: currentRuleSet().version,
  as_of: '2026-11-03T12:00:00.000Z',
  locations: [],
  destinations: [],
  declarations: [],
  collection_registrations: [],
  sales: [],
  ...over,
});
const sale = (
  country: string,
  state: string | null,
  currency: string,
  month: string,
  net: number,
  transactions = 1,
) => ({ country, state, currency, month, net_minor: String(net), transactions });
const outsideEu = {
  id: 'taxol_hq',
  kind: 'head_office' as const,
  country: 'US',
  state: 'DE',
  started: null,
  ended: null,
};
const inIreland = { ...outsideEu, id: 'taxol_ie', country: 'IE', state: null };

const resultFor = (inputs: AssessmentInputs, rule: string | null, country?: string) => {
  const found = evaluate(inputs, currentRuleSet()).find(
    (each) =>
      each.result.rule === rule && (country === undefined || each.result.country === country),
  );
  if (!found) throw new Error(`no result for ${rule} ${country}`);
  return found;
};

describe('the rule set', () => {
  test('every rule names an official source and an effective date, and is marked unreviewed', () => {
    const dto = ruleSetDto(currentRuleSet());
    expect(dto.rules.map((rule) => rule.id)).toEqual([EU_VAT_RULE, US_TX_RULE]);
    for (const rule of dto.rules) {
      expect(rule.sources.length).toBeGreaterThan(0);
      for (const source of rule.sources) expect(source.url).toStartWith('https://');
      expect(rule.effective_from).toBeGreaterThan(0);
      expect(rule.review.status).toBe('unreviewed');
    }
    expect(dto.rules[0]?.threshold).toEqual({
      amount: '1000000',
      currency: 'EUR',
      period: 'current_or_previous_calendar_year',
    });
    expect(dto.rules[1]?.threshold?.amount).toBe('50000000');
  });

  test('an unknown version is not silently replaced by the current one', () => {
    expect(ruleSetByVersion('1999-01-01.1')).toBeUndefined();
  });
});

describe('EU VAT (OSS)', () => {
  test('an EU-established seller below EUR 10 000 cross-border: not indicated; its own state is excluded', () => {
    const { result, findings } = resultFor(
      base({
        locations: [inIreland],
        sales: [
          sale('DE', null, 'EUR', '2026-03', 400_000),
          sale('IE', null, 'EUR', '2026-03', 5_000_000),
        ],
      }),
      EU_VAT_RULE,
    );
    expect(result.outcome).toBe('not_indicated');
    expect(result.measured?.amount).toBe('400000');
    expect(findings).toEqual([]);
  });

  test('crossing the threshold in the PREVIOUS year still counts, and opens an action item', () => {
    const { result, findings } = resultFor(
      base({ locations: [inIreland], sales: [sale('FR', null, 'EUR', '2025-06', 1_000_001)] }),
      EU_VAT_RULE,
    );
    expect(result.outcome).toBe('likely_required');
    expect(findings.map((f) => [f.code, f.severity])).toEqual([
      ['threshold_exceeded', 'action_required'],
    ]);
  });

  test('exactly EUR 10 000 does not exceed it; 80% is approaching', () => {
    const at = (net: number) =>
      resultFor(
        base({ locations: [inIreland], sales: [sale('FR', null, 'EUR', '2026-01', net)] }),
        EU_VAT_RULE,
      ).result.outcome;
    expect(at(1_000_000)).toBe('approaching_threshold');
    expect(at(800_000)).toBe('approaching_threshold');
    expect(at(799_999)).toBe('not_indicated');
  });

  test('a seller established outside the EU owes from the first sale (no threshold)', () => {
    const { result, findings } = resultFor(
      base({ locations: [outsideEu], sales: [sale('NL', null, 'EUR', '2026-10', 999)] }),
      EU_VAT_RULE,
    );
    expect(result.outcome).toBe('likely_required');
    expect(result.reasons.map((r) => r.code)).toContain('non_eu_supplier_no_threshold');
    expect(findings[0]?.code).toBe('registration_likely_required');
  });

  test('no declared establishment with EU sales is uncertain — never guessed from anything else', () => {
    const { result, findings } = resultFor(
      base({ sales: [sale('NL', null, 'EUR', '2026-10', 999)] }),
      EU_VAT_RULE,
    );
    expect(result.outcome).toBe('uncertain');
    expect(findings[0]?.code).toBe('establishment_unknown');
  });

  test('sales in another currency are named, not converted, and make the result uncertain', () => {
    const { result, findings } = resultFor(
      base({ locations: [inIreland], sales: [sale('DE', null, 'USD', '2026-02', 5_000_000)] }),
      EU_VAT_RULE,
    );
    expect(result.measured?.excluded_currencies).toEqual(['USD']);
    expect(result.outcome).toBe('uncertain');
    expect(findings.map((f) => f.code)).toContain('unconverted_sales');
  });

  test('a declared OSS registration is shown as declared, and flags that Peable does not collect', () => {
    const { result, findings } = resultFor(
      base({
        locations: [outsideEu],
        sales: [sale('NL', null, 'EUR', '2026-10', 999)],
        declarations: [
          {
            id: 'taxrd_oss',
            country: 'IE',
            state: null,
            scheme: 'eu_oss_non_union',
            status: 'registered',
            effective_from: '2026-01-01T00:00:00.000Z',
            effective_to: null,
          },
        ],
      }),
      EU_VAT_RULE,
    );
    expect(result.outcome).toBe('registration_declared');
    expect(findings.map((f) => f.code)).toEqual(['collection_not_configured']);
  });
});

describe('Texas sales tax', () => {
  test('USD 500 000 in the preceding twelve months: likely required, with the permit deadline', () => {
    const sales = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'].map((month) =>
      sale('US', 'TX', 'USD', month, 10_000_000),
    );
    const { result, findings } = resultFor(base({ sales }), US_TX_RULE);
    expect(result.outcome).toBe('likely_required');
    // Crossed with the window ending July 2026 → permit by 1 November 2026.
    expect(result.deadline?.due).toBe(Date.UTC(2026, 10, 1) / 1000);
    expect(findings.map((f) => f.code)).toEqual(['threshold_exceeded']);
  });

  test('the month in progress is not part of the preceding twelve calendar months', () => {
    const { result } = resultFor(
      base({ sales: [sale('US', 'TX', 'USD', '2026-11', 60_000_000)] }),
      US_TX_RULE,
    );
    expect(result.outcome).toBe('not_indicated');
  });

  test('a declared location in Texas takes the seller out of the safe harbor: uncertain, action required', () => {
    const { result, findings } = resultFor(
      base({ locations: [{ ...outsideEu, id: 'taxol_tx', kind: 'warehouse', state: 'TX' }] }),
      US_TX_RULE,
    );
    expect(result.outcome).toBe('uncertain');
    expect(findings[0]).toMatchObject({ code: 'physical_presence', severity: 'action_required' });
  });

  test('an unknown status and a pending application are escalated, never treated as registered', () => {
    const { result, findings } = resultFor(
      base({
        declarations: [
          {
            id: 'taxrd_unknown',
            country: 'US',
            state: 'TX',
            scheme: null,
            status: 'unknown',
            effective_from: null,
            effective_to: null,
          },
          {
            id: 'taxrd_pending',
            country: 'US',
            state: 'TX',
            scheme: 'us_state_sales_tax',
            status: 'application_pending',
            effective_from: null,
            effective_to: null,
          },
        ],
      }),
      US_TX_RULE,
    );
    expect(result.outcome).toBe('uncertain');
    expect(findings.map((f) => f.code).sort()).toEqual([
      'application_pending',
      'registration_status_unknown',
    ]);
  });

  test('sales after an ENDED registration are flagged', () => {
    const { result, findings } = resultFor(
      base({
        declarations: [
          {
            id: 'taxrd_ended',
            country: 'US',
            state: 'TX',
            scheme: 'us_state_sales_tax',
            status: 'ended',
            effective_from: '2025-01-01T00:00:00.000Z',
            effective_to: '2026-06-30T00:00:00.000Z',
          },
        ],
        sales: [sale('US', 'TX', 'USD', '2026-08', 1_000)],
      }),
      US_TX_RULE,
    );
    expect(result.outcome).not.toBe('registration_declared');
    expect(findings.map((f) => f.code)).toContain('sales_after_registration_ended');
  });
});

describe('everything else', () => {
  test('sales in an unsupported jurisdiction are reported and escalated, never assessed', () => {
    const results = evaluate(
      base({
        sales: [sale('US', 'CA', 'USD', '2026-05', 123), sale('JP', null, 'JPY', '2026-05', 9)],
      }),
      currentRuleSet(),
    );
    const unsupported = results.filter((each) => each.result.outcome === 'unsupported');
    expect(unsupported.map((each) => [each.result.country, each.result.state])).toEqual([
      ['JP', null],
      ['US', 'CA'],
    ]);
    for (const each of unsupported) {
      expect(each.result.measured).toBeNull();
      expect(each.findings.map((f) => f.code)).toEqual(['unsupported_jurisdiction_sales']);
    }
  });

  test('approved Peable collection with no declared authority registration is a review item', () => {
    const results = evaluate(
      base({
        collection_registrations: [
          {
            id: 'taxreg_ny',
            country: 'US',
            state: 'NY',
            scheme: 'us_state_sales_tax',
            active_from: '2026-01-01T00:00:00.000Z',
            expires_at: null,
          },
        ],
      }),
      currentRuleSet(),
    );
    const ny = results.find((each) => each.result.state === 'NY');
    expect(ny?.findings.map((f) => f.code)).toEqual(['collection_without_declared_registration']);
  });

  test('evaluation is deterministic: the same inputs give byte-identical results', () => {
    const inputs = base({
      locations: [inIreland],
      sales: [sale('FR', null, 'EUR', '2026-04', 2_000_000), sale('US', 'TX', 'USD', '2026-01', 1)],
    });
    expect(JSON.stringify(evaluate(inputs, currentRuleSet()))).toBe(
      JSON.stringify(evaluate(structuredClone(inputs), currentRuleSet())),
    );
  });

  test('the sales window covers both rules: two years of months and the previous calendar year', () => {
    expect(salesWindowStart(new Date('2026-11-03T00:00:00Z')).toISOString()).toBe(
      '2024-11-01T00:00:00.000Z',
    );
  });
});
