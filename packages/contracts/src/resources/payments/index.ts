import { chargeRoutes } from './charges';
import { disputeRoutes } from './disputes';
import { paymentIntentRoutes } from './paymentIntents';
import { radarRoutes } from './radar';
import { refundRoutes } from './refunds';
import { setupIntentRoutes } from './setupIntents';
import { socialRoutes } from './social';
import { paymentIntentTestHelperRoutes } from './testHelpers';

export * from './charges';
export * from './disputes';
export * from './paymentIntents';
export * from './radar';
export * from './refunds';
export * from './setupIntents';
export * from './social';
export * from './testHelpers';

/** Payment intents, charges, refunds, disputes, risk rules and reviews, setup intents, social payments. */
export const paymentsRoutes = [
  ...paymentIntentRoutes,
  ...chargeRoutes,
  ...refundRoutes,
  ...disputeRoutes,
  ...radarRoutes,
  ...setupIntentRoutes,
  ...socialRoutes,
  ...paymentIntentTestHelperRoutes,
] as const;
