import { expect, test } from 'bun:test';
import { verifyStripeAccountIdentity } from '../accountIdentity';
test('card startup requires the exact configured business account before serving', async () => {
  let reads = 0;
  const readAccount = async () => {
    reads++;
    return { id: 'acct_oxy' };
  };
  await verifyStripeAccountIdentity({ enabled: false, expectedAccountId: undefined, readAccount });
  await expect(
    verifyStripeAccountIdentity({ enabled: true, expectedAccountId: undefined, readAccount }),
  ).rejects.toThrow('STRIPE_ACCOUNT_ID');
  expect(reads).toBe(0);
  await expect(
    verifyStripeAccountIdentity({ enabled: true, expectedAccountId: 'acct_other', readAccount }),
  ).rejects.toThrow('does not match');
  await verifyStripeAccountIdentity({ enabled: true, expectedAccountId: 'acct_oxy', readAccount });
  expect(reads).toBe(2);
});
