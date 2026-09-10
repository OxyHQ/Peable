// The ONLY place this app touches `@peable.to/sdk/checkout`. Every route reads a
// `PaymentIntent` through the functions below, never through
// `createPeableCheckout` directly — swapping the workspace SDK for the
// published one later is a one-line change here, and tests mock this module
// instead of the SDK package.
import { createPeableCheckout } from '@peable.to/sdk/checkout';
import type { RealtimeConnectionState } from '@peable.to/sdk/checkout';
import type { PaymentIntent } from '@peable.to/shared-types';
import { GATEWAY_URL } from './config';

const client = createPeableCheckout({ gatewayUrl: GATEWAY_URL });

export function getPaymentIntent(id: string, clientSecret: string): Promise<PaymentIntent> {
  return client.getPaymentIntent(id, clientSecret);
}

/**
 * Resolves to the `unsubscribe` function once the realtime subscription is live.
 *
 * `onConnectionChange` reports drops and recoveries AFTER that point. It is
 * forwarded rather than handled here because this module is a pass-through to
 * the SDK by design; what to DO about a drop is `CheckoutView`'s decision.
 */
export async function subscribe(
  id: string,
  clientSecret: string,
  onUpdate: (intent: PaymentIntent) => void,
  onConnectionChange?: (state: RealtimeConnectionState) => void,
): Promise<() => void> {
  const subscription = await client.subscribe(id, clientSecret, onUpdate, onConnectionChange);
  return subscription.unsubscribe;
}

export function submitTx(id: string, clientSecret: string, txid: string): Promise<PaymentIntent> {
  return client.submitTx(id, clientSecret, txid);
}
