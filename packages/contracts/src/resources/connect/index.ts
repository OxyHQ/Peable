import { accountRoutes } from './account';
import { applicationFeeRoutes } from './applicationFees';
import { balanceRoutes } from './balance';
import { connectedAccountRoutes } from './connectedAccounts';
import { connectOnboardingRoutes } from './onboarding';
import { payoutRoutes } from './payouts';
import { reportingRoutes } from './reporting';
import { requestLogRoutes } from './requestLogs';
import { transferRoutes } from './transfers';

export * from './account';
export * from './applicationFees';
export * from './balance';
export * from './connectedAccounts';
export * from './onboarding';
export * from './payouts';
export * from './reporting';
export * from './requestLogs';
export * from './transfers';

/**
 * Connect and money (ADR 0012, ADR 0015): connected accounts and their
 * onboarding, the merchant's account, balance, payouts, application fees,
 * transfers, reporting and the request log.
 */
export const connectRoutes = [
  ...connectedAccountRoutes,
  ...accountRoutes,
  ...balanceRoutes,
  ...payoutRoutes,
  ...applicationFeeRoutes,
  ...connectOnboardingRoutes,
  ...transferRoutes,
  ...reportingRoutes,
  ...requestLogRoutes,
] as const;
