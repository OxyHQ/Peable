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
  type PeableClientAction,
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
  payableByExternalWallet,
  buildPayDeepLink,
  type PayDeepLinkOutput,
  type PayDeepLinkParams,
  PeableRailUnsupportedError,
} from './browser/payDeepLink';

export {
  mountCheckout,
  mountCheckoutIn,
  type MountCheckoutOptions,
  type EmbeddedCheckoutInstance,
  type EmbeddedCheckoutEnvironment,
} from './browser/embeddedCheckout';

export {
  createPeableElements,
  createPeableElementsWith,
  awaitGateway,
  decidePayment,
  decideSetup,
  providerAmount,
  type CreatePeableElementsOptions,
  type PeableElements,
  type PeableElement,
  type PeableElementType,
  type PeableElementOptions,
  type PeableElementEvent,
  type PeableConfirmError,
  type PeablePaymentResult,
  type PeableSetupResult,
  type ConfirmOptions,
  type ElementsDependencies,
  type GatewayDecision,
} from './browser/elements';

export {
  DEFAULT_CHECKOUT_URL,
  EMBED_MESSAGE_SOURCE,
  EMBED_PROTOCOL_VERSION,
  type EmbedFrameMessage,
  type EmbedHostMessage,
  type EmbedEnvelope,
  sessionIdFromClientSecret,
  normalizeOrigin,
  buildEmbedUrl,
  parseEmbedFragment,
  envelope as embedEnvelope,
  readFrameMessage,
  readHostMessage,
} from './browser/embedProtocol';

export {
  APPEARANCE_THEMES,
  APPEARANCE_RULE_SELECTORS,
  FONT_STACKS,
  BORDER_RADII,
  type Appearance,
  type AppearanceTheme,
  type AppearanceVariables,
  type AppearanceRules,
  resolveAppearance,
  toProviderAppearance,
  toCssVariables,
  appearanceFromBranding,
} from './browser/appearance';

export {
  loadProviderSdk,
  type ProviderElement,
  type ProviderElements,
  type ProviderFieldEvent,
  type ProviderSdk,
  type ProviderConfirmResult,
  type ProviderSetupConfirmResult,
  type ProviderElementType,
  type ProviderFactory,
} from './browser/providerJs';

// The card rail's wallets + payment fields, shared with `packages/checkout`
// so the hosted page and the embeddable widget confirm a card payment the same
// way.
export {
  EXPRESS_CHECKOUT_OPTIONS,
  availableWallets,
  delayedProcessingNotice,
  mountCardElements,
  readRedirectReturn,
  withoutRedirectParams,
  type CardConfirmOutcome,
  type CardElementsHandle,
  type CardElementsOptions,
  type ExpressWallet,
} from './browser/cardElements';
