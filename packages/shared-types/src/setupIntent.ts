// A SetupIntent (`seti_…`) — saving a card for later without charging it
// (ADR 0016, ADR 0019). The wire type is the contract's (`@peable.to/contracts`
// `setupIntentSchema`), re-exported here as a type; the value sets are the
// contract's zod-free vocabulary.
export type {
  CancelSetupIntentParams,
  CreateSetupIntentParams,
  ListSetupIntentsParams,
  RetrieveSetupIntentParams,
  SetupIntent,
} from '@peable.to/contracts';
export {
  SETUP_INTENT_CANCELLATION_REASONS,
  SETUP_INTENT_STATUSES,
  SETUP_INTENT_USAGES,
  type SetupIntentCancellationReason,
  type SetupIntentStatus,
  type SetupIntentUsage,
} from '@peable.to/contracts/vocabulary';
