/**
 * `@peable.to/pay/ui` — the payment sheet, and the pure logic under it.
 *
 * ITS OWN EXPORT SUBPATH, never reachable from `@peable.to/pay`'s root barrel.
 * Everything here names React, React Native and `@oxy.so/bloom`, and `tsc`
 * resolves a re-exported specifier whether or not anything imports it — so one
 * line in the root barrel would turn four optional peers into hard install
 * requirements for a server-side consumer that only wanted `sendPayment`.
 *
 * The pure modules are exported alongside the component because they are the
 * testable half: a host that wants a different surface (a full screen, a
 * different design system) can drive `payReducer` itself and keep the money
 * guarantees — the reviewed fee is the sent fee, a superseded attempt decides
 * nothing, and a broadcast failure never offers a one-tap retry.
 */

export { PeablePaySheet } from './PeablePaySheet';
export type {
  PeablePaySheetProps,
  PayRecipient,
  PaySheetWallet,
  PaySource,
} from './PeablePaySheet';

export { PayQrCode } from './PayQrCode';

export {
  DEFAULT_PRESETS_SAT,
  amountEntryMessage,
  amountInputFor,
  parseAmountInput,
  sanitizeAmountInput,
} from './amount';
export type { AmountEntry } from './amount';

export {
  classifyPayFailure,
  insufficientFundsFailure,
  isKeylessRecipient,
  recoveryFor,
} from './failure';
export type { PayFailure, PayFailureKind, PayRecovery, PayStage } from './failure';

export {
  handoffFor,
  initialPayState,
  paidFrom,
  payReducer,
  prepareFromQuote,
  sendRequestFor,
} from './machine';
export type {
  HandoffOffer,
  PaidPayment,
  PayEvent,
  PayState,
  PreparedOutcome,
  ReviewedPayment,
} from './machine';
