// Browser entry (`@peable.to/sdk/checkout`) — the anonymous payer-side client
// core (Task 5) plus the embeddable pay-button widget (Task 6). Deliberately
// imports nothing from `./core/*` beyond `core/errors.ts` (a pure
// status-mapper with no service-token/secret machinery): the browser bundle
// must never carry the merchant-authed code or a path to a secret.
//
// `packages/checkout` (the hosted checkout page, a separate package) can
// still consume `createPeableCheckout` directly instead of `PeableCheckout`
// when it wants to build its own UI over the payer client core (see the
// checkout+links plan's `intentClient.ts`).
export {
  createPeableCheckout,
  type CreatePeableCheckoutOptions,
  type PeableCheckoutClient,
  type RealtimeConnectionState,
} from './browser/payerClient';

export {
  PeableCheckout,
  type PeableCheckoutMountOptions,
  type PeableCheckoutInstance,
  type PeableCheckoutEventMap,
} from './browser/mount';

// The rail-aware deep-link builder and its refusal. Exported because
// `packages/checkout` renders its own pay button over the payer client core
// and must make the same decision this widget makes — one definition of "which
// intents have a wallet deep link", not two.
export {
  payDeepLinkFor,
  buildPayDeepLink,
  type PayDeepLinkParams,
  PeableRailUnsupportedError,
} from './browser/mount';
