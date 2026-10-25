import type { PaymentIntent } from '@peable.to/shared-types';
import { GATEWAY_SOCKET_URL } from '@/config';
import { oxyServices } from '@/services/oxy-services';
import { openIntentSubscription } from './intent-subscription';
export type { IntentSubscription } from './intent-subscription';

/** Wallet status uses its live Oxy session plus the existing intent client secret. */
export function subscribeToIntent(
  intentId: string,
  clientSecret: string,
  onUpdate: (intent: PaymentIntent) => void,
  signal?: AbortSignal,
) {
  return openIntentSubscription(
    oxyServices,
    GATEWAY_SOCKET_URL,
    intentId,
    clientSecret,
    onUpdate,
    signal,
  );
}
