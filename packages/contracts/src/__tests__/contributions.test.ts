import { test, expect } from 'bun:test';
import {
  contributionAmountSchema,
  createContributionSchema,
  decimalContributionAmount,
  formatContributionAmount,
} from '../index';
test('FAIR precision uses exact integer arithmetic across all eight decimals', () => {
  expect(decimalContributionAmount('0.00000001')).toBe('1');
  expect(decimalContributionAmount('1.25000001')).toBe('125000001');
  expect(formatContributionAmount('125000001')).toBe('1.25000001');
  expect(decimalContributionAmount(formatContributionAmount('9007199254740991'))).toBe(
    '9007199254740991',
  );
});
test('malformed or excessive amounts return validation failures instead of throwing in safeParse', () => {
  for (const value of ['0', '-1', '01', '1.5', '1e3', '9007199254740992'])
    expect(contributionAmountSchema.safeParse(value).success).toBe(false);
});
test('contributions have fixed/free semantics and accept only FAIR', () => {
  const body = { purpose: 'Garden', amountMode: 'free', currency: 'FAIR' };
  expect(createContributionSchema.safeParse(body).success).toBe(true);
  expect(createContributionSchema.safeParse({ ...body, currency: 'EUR' }).success).toBe(false);
  expect(createContributionSchema.safeParse({ ...body, amount: '1' }).success).toBe(false);
  expect(createContributionSchema.safeParse({ ...body, amountMode: 'fixed' }).success).toBe(false);
  expect(
    createContributionSchema.safeParse({ ...body, amountMode: 'fixed', amount: '1' }).success,
  ).toBe(true);
});
