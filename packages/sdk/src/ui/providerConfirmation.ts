import type { ProviderConfirmResult } from '../browser/providerJs';
/** Provider acceptance is pending gateway verification; this function never establishes settlement. */
export function providerAcceptedConfirmation(result: ProviderConfirmResult): boolean {
  return (
    !result.error &&
    ['succeeded', 'processing', 'requires_capture'].includes(result.paymentIntent?.status ?? '')
  );
}
