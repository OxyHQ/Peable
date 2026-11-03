// One provider loader, and one card surface, for hosted checkout and the
// SDK's embeddable widget: wallets + payment fields confirmed the same way
// (`@peable.to/sdk/checkout`'s `mountCardElements`). Setup mode confirms a
// SetupIntent through the provider's own `confirmSetup`.
import type { ProviderSdk, ProviderSetupConfirmResult } from '@peable.to/sdk/checkout';

export {
  loadProviderSdk,
  mountCardElements,
  readRedirectReturn,
  withoutRedirectParams,
  delayedProcessingNotice,
  type CardConfirmOutcome,
  type CardElementsHandle,
  type ExpressWallet,
  type ProviderElement,
  type ProviderElements,
  type ProviderSdk,
  type ProviderConfirmResult,
} from '@peable.to/sdk/checkout';

export type ConfirmSetup = NonNullable<ProviderSdk['confirmSetup']>;

/** The provider's `confirmSetup`, bound, or `null` when this provider build has none. */
export function confirmSetupOf(sdk: ProviderSdk): ConfirmSetup | null {
  const fn = sdk.confirmSetup;
  return typeof fn === 'function' ? (fn.bind(sdk) as ConfirmSetup) : null;
}

export type { ProviderSetupConfirmResult };
