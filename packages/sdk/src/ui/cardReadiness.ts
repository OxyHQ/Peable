import type { PeableClientAction } from '../browser/payerClient';

/** Public field configuration is not authority to tokenize for a checkout. */
export function matchingCardAction(
  action: PeableClientAction | undefined,
  publishableKey: string | undefined,
): PeableClientAction | undefined {
  return action?.kind === 'client_secret' &&
    action.value &&
    publishableKey &&
    action.publishableKey === publishableKey
    ? action
    : undefined;
}
