import { describe, expect, it } from 'bun:test';
import type { AccountRequirements } from '@peable.to/shared-types';
import { FAIRCOIN_KEY_REQUIREMENT } from '@peable.to/contracts/vocabulary';
import {
  disabledReasonLabel,
  humanizeRequirement,
  onboardingAction,
  requirementLabel,
  requirementLabels,
  requirementsClear,
} from './requirements';

const none: AccountRequirements = {
  currently_due: [],
  eventually_due: [],
  past_due: [],
  pending_verification: [],
  disabled_reason: null,
};

describe('requirementLabel', () => {
  it('words the seller’s FairCoin receiving key (ADR 0021 D5)', () => {
    expect(requirementLabel(FAIRCOIN_KEY_REQUIREMENT)).toBe(
      'The seller’s FairCoin receiving key (the seller registers it from the onboarding link)',
    );
  });

  it('words a known identifier', () => {
    expect(requirementLabel('external_account')).toBe('Bank account for payouts');
    expect(requirementLabel('individual.verification.document')).toBe('An identity document');
  });

  it('folds the parts of a date or an address into the whole', () => {
    expect(requirementLabel('individual.dob.day')).toBe('Your date of birth');
    expect(requirementLabel('company.address.line1')).toBe('Company address');
  });

  it('reads a provider person id as a person, never showing it', () => {
    expect(requirementLabel('person_1AbC.first_name')).toBe('Details of a person on the account');
    expect(requirementLabel('representative.first_name')).toBe(
      'Details of the company representative',
    );
  });

  it('falls back to the longest known prefix, then to the identifier in words', () => {
    expect(requirementLabel('tos_acceptance.date')).toBe('Acceptance of the provider’s terms');
    expect(requirementLabel('settings.payments.thing')).toBe('Settings › payments › thing');
  });
});

describe('requirementLabels', () => {
  it('says each thing once', () => {
    expect(
      requirementLabels(['individual.dob.day', 'individual.dob.month', 'individual.dob.year']),
    ).toEqual(['Your date of birth']);
  });
});

describe('humanizeRequirement', () => {
  it('capitalizes the first part and spaces the underscores', () => {
    expect(humanizeRequirement('company.tax_id')).toBe('Company › tax id');
  });
});

describe('disabledReasonLabel', () => {
  it('words the provider code, or answers null when nothing is disabled', () => {
    expect(disabledReasonLabel(null)).toBeNull();
    expect(disabledReasonLabel('requirements.past_due')).toBe('Required information is past due');
    expect(disabledReasonLabel('something_new')).toBe('Something new');
  });
});

describe('requirementsClear', () => {
  it('is clear only with nothing owed, nothing being verified and nothing disabled', () => {
    expect(requirementsClear(none)).toBe(true);
    expect(requirementsClear({ ...none, pending_verification: ['x'] })).toBe(false);
    expect(requirementsClear({ ...none, disabled_reason: 'under_review' })).toBe(false);
  });
});

describe('onboardingAction', () => {
  it('starts a fresh account, resumes one with something owed, and updates a complete one', () => {
    expect(
      onboardingAction({
        charges_enabled: false,
        payouts_enabled: false,
        requirements: { ...none, currently_due: ['external_account'] },
      }),
    ).toBe('start');
    expect(
      onboardingAction({
        charges_enabled: true,
        payouts_enabled: false,
        requirements: { ...none, currently_due: ['external_account'] },
      }),
    ).toBe('resume');
    expect(
      onboardingAction({ charges_enabled: true, payouts_enabled: true, requirements: none }),
    ).toBe('update');
  });
});
