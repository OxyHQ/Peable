import { describe, expect, test } from 'bun:test';
import {
  selectStripeApiVersion,
  DEFAULT_STRIPE_API_VERSION,
  LOCAL_TEST_STRIPE_API_VERSION,
} from '../apiVersion';
const local = {
  DATABASE_URL: 'postgres://local:local@127.0.0.1:5439/peable_stripe_test',
  STRIPE_SECRET_KEY_TEST: 'rk_test_example',
  STRIPE_PUBLISHABLE_KEY_TEST: 'pk_test_example',
  STRIPE_ENABLED: 'true',
  STRIPE_WEBHOOK_SECRET_TEST: 'whsec_example',
  STRIPE_CONNECT_WEBHOOK_SECRET_TEST: 'whsec_connect',
  PEABLE_TEST_STRIPE_ACCOUNT: 'acct_local',
  PEABLE_TEST_RUN_ID: 'test-version',
  PEABLE_TEST_STRIPE_API_VERSION: LOCAL_TEST_STRIPE_API_VERSION,
};
describe('reviewed Stripe version selection', () => {
  test('keeps the production pin when no override is supplied', () => {
    expect(selectStripeApiVersion({ NODE_ENV: 'production' })).toBe(DEFAULT_STRIPE_API_VERSION);
  });
  test('selects the coherent local version only inside the complete test boundary', () => {
    expect(selectStripeApiVersion(local)).toBe(LOCAL_TEST_STRIPE_API_VERSION);
  });
  test.each([
    { NODE_ENV: 'production' },
    { STRIPE_SECRET_KEY_TEST: 'sk_live_example' },
    { STRIPE_SECRET_KEY_LIVE: 'sk_live_example' },
    { DATABASE_URL: 'postgres://local:local@db.example:5439/peable_stripe_test' },
    { DATABASE_URL: 'postgres://local:local@127.0.0.1:5439/production' },
    { STRIPE_WEBHOOK_SECRET_TEST: undefined },
    { PEABLE_TEST_STRIPE_API_VERSION: '2026-10-28.endive' },
  ])('refuses an unreviewed runtime boundary %j', (change) => {
    expect(() => selectStripeApiVersion({ ...local, ...change })).toThrow();
  });
});
