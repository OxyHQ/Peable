import { assertLocalStripeTestEnvironment } from '../localTestBoundary';

export const DEFAULT_STRIPE_API_VERSION = '2026-07-29.dahlia' as const;
export const LOCAL_TEST_STRIPE_API_VERSION = '2026-09-30.endive' as const;
export type ReviewedStripeApiVersion =
  | typeof DEFAULT_STRIPE_API_VERSION
  | typeof LOCAL_TEST_STRIPE_API_VERSION;

/** A reviewed local request/delivery pair, never an arbitrary or live version override. */
export function selectStripeApiVersion(
  env: Record<string, string | undefined>,
): ReviewedStripeApiVersion {
  const requested = env.PEABLE_TEST_STRIPE_API_VERSION;
  if (requested === undefined) return DEFAULT_STRIPE_API_VERSION;
  if (requested !== LOCAL_TEST_STRIPE_API_VERSION)
    throw new Error('Unsupported PEABLE_TEST_STRIPE_API_VERSION');
  assertLocalStripeTestEnvironment(env);
  return LOCAL_TEST_STRIPE_API_VERSION;
}
