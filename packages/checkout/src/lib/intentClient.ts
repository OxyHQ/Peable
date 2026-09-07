// The ONLY place this app touches `@peable.to/sdk/checkout`. Every route reads a
// `PaymentIntent` through the functions below, never through
// `createPeableCheckout` directly — swapping the workspace SDK for the
// published one later is a one-line change here, and tests mock this module
// instead of the SDK package.
import { createPeableCheckout } from '@peable.to/sdk/checkout';
import type { PaymentIntent } from '@peable.to/shared-types';
import { GATEWAY_URL } from './config';

const client = createPeableCheckout({ gatewayUrl: GATEWAY_URL });

export function getPaymentIntent(id: string, clientSecret: string): Promise<PaymentIntent> {
  return client.getPaymentIntent(id, clientSecret);
}

/** Resolves to the `unsubscribe` function once the realtime subscription is live. */
export async function subscribe(
  id: string,
  clientSecret: string,
  onUpdate: (intent: PaymentIntent) => void,
): Promise<() => void> {
  const subscription = await client.subscribe(id, clientSecret, onUpdate);
  return subscription.unsubscribe;
}

export function submitTx(id: string, clientSecret: string, txid: string): Promise<PaymentIntent> {
  return client.submitTx(id, clientSecret, txid);
}
