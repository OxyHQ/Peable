import { describe, expect, it } from 'bun:test';
import { assertLocalStripeTestEnvironment } from './stripeTestGuard';
const valid = {
  DATABASE_URL: 'postgres://local:local@127.0.0.1:5439/peable_stripe_test',
  STRIPE_SECRET_KEY: 'rk_test_placeholder',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_placeholder',
  STRIPE_ENABLED: 'true',
  STRIPE_WEBHOOK_SECRET: 'test-signing',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'test-connect-signing',
  PEABLE_TEST_STRIPE_ACCOUNT: 'acct_test',
  PEABLE_TEST_RUN_ID: 'run-1',
};
describe('local Stripe test boundary', () => {
  it('accepts a complete isolated test configuration', () =>
    expect(() => assertLocalStripeTestEnvironment(valid)).not.toThrow());
  for (const patch of [
    { DATABASE_URL: 'postgres://local:local@remote.example:5439/peable_stripe_test' },
    { DATABASE_URL: 'postgres://local:local@127.0.0.1:5439/oxypay' },
    { DATABASE_URL: 'postgres://local:local@127.0.0.1:5432/peable_stripe_test' },
    { STRIPE_SECRET_KEY: 'rk_live_placeholder' },
    { STRIPE_PUBLISHABLE_KEY: 'pk_live_placeholder' },
    { STRIPE_CONNECT_WEBHOOK_SECRET: '' },
    { NODE_ENV: 'production' },
    { PEABLE_TEST_RUN_ID: '' },
  ])
    it(`refuses ${Object.keys(patch)[0]} outside the test boundary`, () => {
      expect(() => assertLocalStripeTestEnvironment({ ...valid, ...patch })).toThrow();
    });
});
