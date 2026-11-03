/** Deployment identity is explicit; a valid key for another business is not readiness. */
export async function verifyStripeAccountIdentity(input: {
  enabled: boolean;
  expectedAccountId: string | undefined;
  readAccount: () => Promise<{ id: string }>;
}): Promise<void> {
  if (!input.enabled) return;
  if (!/^acct_[A-Za-z0-9]+$/.test(input.expectedAccountId ?? ''))
    throw new Error('STRIPE_ACCOUNT_ID is required before enabling the card rail');
  const account = await input.readAccount();
  if (account.id !== input.expectedAccountId)
    throw new Error('Stripe credential does not match the configured STRIPE_ACCOUNT_ID');
}
