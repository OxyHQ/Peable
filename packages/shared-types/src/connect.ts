// The seller-facing half of FairCoin connected accounts (ADR 0012 D3): the
// shapes the onboarding page reads and writes, and the onboarding link a
// platform mints. The wire types are the contract's (`@peable.to/contracts`),
// re-exported here as types.
export type {
  AccountLink,
  ConnectOnboarding,
  ConnectOnboardingComplete,
  RegisterFaircoinKeyParams,
} from '@peable.to/contracts';
