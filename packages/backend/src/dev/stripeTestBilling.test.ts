import { expect, it } from 'bun:test';
import {
  LOCAL_TEST_APP,
  localTestBillingConfiguration,
  requireLocalBillingReturnUrl,
} from './stripeTestBilling';
const merchant = {
  id: 'local-id',
  oxyAppId: LOCAL_TEST_APP,
  environment: 'development',
  livemode: false,
  webhookUrl: null,
};
it('configures a test-only recurring observer without a production entitlement target', () => {
  const result = localTestBillingConfiguration(merchant, 'acct_test');
  expect(result.deployment.livemode).toBe(false);
  expect(result.cohorts[0]?.environment).toBe('development');
  expect(result.observationsEnabled).toBe(true);
  expect(result.observationTimeoutMs).toBe(10_000);
});
for (const patch of [
  { livemode: true },
  { environment: 'production' },
  { oxyAppId: 'real-app' },
  { webhookUrl: 'https://prod.example/webhook' },
]) {
  it('rejects a nonlocal recurring owner', () =>
    expect(() => localTestBillingConfiguration({ ...merchant, ...patch }, 'acct_test')).toThrow());
}
it('accepts only a loopback HTTPS return', () => {
  expect(requireLocalBillingReturnUrl('https://127.0.0.1:4311/return')).toBe(
    'https://127.0.0.1:4311/return',
  );
  for (const url of [
    'http://localhost:4311',
    'https://mention.earth/plus',
    'https://user:pass@localhost:4311',
    undefined,
  ]) {
    expect(() => requireLocalBillingReturnUrl(url)).toThrow();
  }
});
