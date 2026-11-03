import { describe, expect, it } from 'bun:test';
import {
  TAX_COMPLIANCE_CAPABILITY_STATUSES,
  TAX_DOCUMENT_KINDS,
  TAX_LEGAL_ENTITY_TYPES,
  TAX_OBLIGATION_OUTCOMES,
  TAX_OPERATING_LOCATION_KINDS,
  TAX_REGISTRATION_DECLARATION_STATUSES,
  TAX_REVIEW_DECISIONS,
} from '@peable.to/shared-types/tax';
import { TAX_COMPLIANCE_EN } from './strings';
import {
  countryCode,
  formatDay,
  outcomeTone,
  parseDay,
  placeLabel,
  reviewTone,
  stateCode,
} from './vocabulary';

describe('the compliance vocabulary', () => {
  it('words every value the gateway can send', () => {
    const keys: [string, readonly string[]][] = [
      ['compliance.outcome', TAX_OBLIGATION_OUTCOMES],
      ['compliance.capability', TAX_COMPLIANCE_CAPABILITY_STATUSES],
      ['compliance.status', TAX_REGISTRATION_DECLARATION_STATUSES],
      ['compliance.decision', TAX_REVIEW_DECISIONS],
      ['compliance.document', TAX_DOCUMENT_KINDS],
      ['compliance.entity', TAX_LEGAL_ENTITY_TYPES],
      ['compliance.locationKind', TAX_OPERATING_LOCATION_KINDS],
    ];
    for (const [prefix, values] of keys)
      for (const value of values) expect(TAX_COMPLIANCE_EN[`${prefix}.${value}`]).toBeString();
  });

  it('never shows an obligation outcome as a success', () => {
    for (const outcome of TAX_OBLIGATION_OUTCOMES) expect(outcomeTone(outcome)).not.toBe('success');
    expect(outcomeTone('likely_required')).toBe('danger');
    expect(reviewTone({ status: 'resolved', severity: 'action_required' })).toBe('neutral');
  });

  it('parses only real calendar days', () => {
    expect(parseDay('2026-07-01')).toBe(Date.UTC(2026, 6, 1) / 1000);
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('07/01/2026')).toBeNull();
    expect(formatDay(Date.UTC(2026, 6, 1) / 1000)).toBe('2026-07-01');
  });

  it('reads codes as typed', () => {
    expect(countryCode(' ie ')).toBe('IE');
    expect(countryCode('IRL')).toBeNull();
    expect(stateCode('tx')).toBe('TX');
    expect(placeLabel('US', 'TX')).toBe('US-TX');
    expect(placeLabel(null, null)).toBe('All EU member states');
  });
});
