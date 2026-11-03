/** Local harness only: refuse remote databases and every non-test provider key. */
export function assertLocalStripeTestEnvironment(env: Record<string, string | undefined>): void {
  let database: URL;
  try {
    database = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw new Error('Local test requires a valid DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    database.hostname !== '127.0.0.1' ||
    database.port !== '5439' ||
    database.pathname !== '/peable_stripe_test'
  )
    throw new Error(
      'Local test requires the isolated loopback peable_stripe_test database on port5439',
    );
  if (env.NODE_ENV === 'production') throw new Error('Local test cannot run in production');
  if (!/^(rk|sk)_test_\S+$/.test(env.STRIPE_SECRET_KEY_TEST ?? '')) {
    throw new Error('Local test requires a Stripe test key');
  }
  if (!/^pk_test_\S+$/.test(env.STRIPE_PUBLISHABLE_KEY_TEST ?? '')) {
    throw new Error('Local test requires a Stripe test publishable key');
  }
  // The live half of the deployment (ADR 0017) must be ABSENT, not merely
  // unused: a harness holding a live key is one wrong environment away from
  // charging a real card.
  const live = [
    env.STRIPE_SECRET_KEY_LIVE,
    env.STRIPE_PUBLISHABLE_KEY_LIVE,
    env.STRIPE_WEBHOOK_SECRET_LIVE,
    env.STRIPE_CONNECT_WEBHOOK_SECRET_LIVE,
  ];
  if (live.some((value) => value !== undefined && value.trim() !== '')) {
    throw new Error('Local test refuses any Stripe live-mode setting');
  }
  if (
    env.STRIPE_ENABLED !== 'true' ||
    !env.STRIPE_WEBHOOK_SECRET_TEST ||
    !env.STRIPE_CONNECT_WEBHOOK_SECRET_TEST
  ) {
    throw new Error(
      'Local test requires the enabled provider and both test webhook signing secrets',
    );
  }
  if (!/^acct_[A-Za-z0-9]+$/.test(env.PEABLE_TEST_STRIPE_ACCOUNT ?? '')) {
    throw new Error('Local test requires the explicitly approved Stripe account id');
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(env.PEABLE_TEST_RUN_ID ?? '')) {
    throw new Error('Local test requires a stable PEABLE_TEST_RUN_ID for idempotent retries');
  }
}
