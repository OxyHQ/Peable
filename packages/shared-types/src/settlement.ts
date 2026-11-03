// The settlement contract — connected accounts, transfers and their reversals.
//
// ## Why these are published now
//
// They were declared inside the backend, with a comment saying they stayed
// there "for as long as they are unstable. Publishing a shape is a promise, and
// the settling half of this contract has not yet been exercised end to end."
// The caution was right and it had a cost that grew: Mercaria's adapter
// declared its OWN partial interfaces for the same responses, so the two
// descriptions of one wire format lived in different repositories with nothing
// comparing them. A field renamed here is a runtime failure there, discovered
// by a settlement that does not happen.
//
// One published shape is the smaller risk. A promise that is written down can
// be versioned; two private copies of it cannot even be checked.
//
// ## The provider's own ids are not here, and that is the contract
//
// ADR 0001 D3: a merchant integrates against Peable and never learns which
// acquirer sat behind their seller, because the day that changes should be a
// Peable deploy and not a merchant migration. No `acct_…`, no `tr_…` of
// theirs, no provider name. A reviewer should be able to check that by what is
// absent from these interfaces.

// Connected accounts, transfers and their reversals: the contract's
// (`@peable.to/contracts`), re-exported here as types.
export type {
  ConnectedAccount,
  ConnectedAccountFaircoin,
  Transfer,
  TransferReversal,
  TransferWithReversal,
} from '@peable.to/contracts';
export type {
  AccountCapabilityStatus as CapabilityStatus,
  ConnectedAccountFaircoinStatus,
  ConnectedAccountRail,
  TransferReversalStatus,
  TransferStatus,
} from '@peable.to/contracts/vocabulary';

// Refunds and a payment's settlement figures: the contract's
// (`@peable.to/contracts` `refundSchema` / `settlementSchema`), re-exported here
// as types; the value sets are the contract's zod-free vocabulary.
export type {
  CreateRefundParams,
  ListRefundsParams,
  PaymentIntentRefundList,
  Refund,
  Settlement,
  UpdateRefundParams,
} from '@peable.to/contracts';
export {
  REFUND_ORIGINS,
  REFUND_REASONS,
  REFUND_STATUSES,
  type RefundOrigin,
  type RefundReason,
  type RefundStatus,
  SETTLEMENT_STATUSES,
  type SettlementStatus,
} from '@peable.to/contracts/vocabulary';
