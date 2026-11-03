import { test, expect } from 'bun:test';
import {
  contributionAmountSchema,
  contributionListSchema,
  contributionPageQuerySchema,
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
  const body = { purpose: 'Garden', amount_mode: 'free', currency: 'FAIR' };
  expect(createContributionSchema.safeParse(body).success).toBe(true);
  expect(createContributionSchema.safeParse({ ...body, currency: 'EUR' }).success).toBe(false);
  expect(createContributionSchema.safeParse({ ...body, amount: '1' }).success).toBe(false);
  expect(createContributionSchema.safeParse({ ...body, amount_mode: 'fixed' }).success).toBe(false);
  expect(
    createContributionSchema.safeParse({ ...body, amount_mode: 'fixed', amount: '1' }).success,
  ).toBe(true);
});
test('the wire is snake_case with Unix-second instants, and nothing else', () => {
  const body = { purpose: 'Garden', amount_mode: 'free', currency: 'FAIR' };
  expect(createContributionSchema.safeParse({ ...body, expires_at: 1_900_000_000 }).success).toBe(
    true,
  );
  expect(
    createContributionSchema.safeParse({ ...body, expires_at: '2030-01-01T00:00:00Z' }).success,
  ).toBe(false);
  expect(createContributionSchema.safeParse({ ...body, expires_at: 1.5 }).success).toBe(false);
  expect(
    createContributionSchema.safeParse({ purpose: 'Garden', amountMode: 'free', currency: 'FAIR' })
      .success,
  ).toBe(false);
});
test('lists use the one envelope and page by starting_after', () => {
  expect(
    contributionListSchema.safeParse({ object: 'list', data: [], has_more: false, url: '/v1/x' })
      .success,
  ).toBe(true);
  // `url` is part of the envelope, not optional.
  expect(
    contributionListSchema.safeParse({ object: 'list', data: [], has_more: false }).success,
  ).toBe(false);
  expect(contributionListSchema.safeParse({ items: [], nextCursor: null }).success).toBe(false);
  expect(
    contributionPageQuerySchema.parse({ environment: 'production', starting_after: 'link_1' }),
  ).toEqual({ environment: 'production', starting_after: 'link_1', limit: 10 });
  expect(
    contributionPageQuerySchema.safeParse({ environment: 'production', cursor: 'x' }).success,
  ).toBe(false);
});
test('the list parameters: ending_before, created ranges, never both cursors', () => {
  expect(
    contributionPageQuerySchema.parse({
      environment: 'production',
      ending_before: 'link_1',
      created: { gte: '100', lt: '200' },
    }),
  ).toEqual({
    environment: 'production',
    ending_before: 'link_1',
    created: { gte: 100, lt: 200 },
    limit: 10,
  });
  expect(
    contributionPageQuerySchema.parse({ environment: 'production', created: '100' }).created,
  ).toEqual({ gte: 100, lte: 100 });
  const both = contributionPageQuerySchema.safeParse({
    environment: 'production',
    starting_after: 'link_1',
    ending_before: 'link_2',
  });
  expect(both.success).toBe(false);
  expect(both.error?.issues[0]?.path).toEqual(['ending_before']);
  expect(
    contributionPageQuerySchema.safeParse({ environment: 'production', created: { after: 1 } })
      .success,
  ).toBe(false);
});
