import { expect, test } from 'bun:test';
import { SETUP_INTENT_STATUSES } from '@peable.to/shared-types';
import { SETUP_INTENT_STATUS_VALUES } from '../../db/schema/valueSets';
import { SETUP_STATUSES_FROM_TABLE, isValidSetupTransition } from '../customers/setupIntentService';

test('the SetupIntent table, the contract and the CHECK name the same six statuses', () => {
  expect([...SETUP_STATUSES_FROM_TABLE].sort()).toEqual([...SETUP_INTENT_STATUSES].sort());
  expect([...SETUP_INTENT_STATUS_VALUES].sort()).toEqual([...SETUP_INTENT_STATUSES].sort());
});

test('succeeded and canceled are terminal; a failed attempt returns to requires_payment_method', () => {
  for (const terminal of ['succeeded', 'canceled'] as const) {
    for (const target of SETUP_INTENT_STATUSES) {
      expect(isValidSetupTransition(terminal, target)).toBe(false);
    }
  }
  for (const from of ['requires_confirmation', 'requires_action', 'processing'] as const) {
    expect(isValidSetupTransition(from, 'requires_payment_method')).toBe(true);
  }
  expect(isValidSetupTransition('requires_action', 'succeeded')).toBe(true);
  expect(isValidSetupTransition('processing', 'requires_action')).toBe(false);
});
