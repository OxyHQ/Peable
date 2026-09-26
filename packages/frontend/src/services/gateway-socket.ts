import { io, type Socket } from 'socket.io-client';
import type { PaymentIntent } from '@peable.to/shared-types';
import { oxyServices } from '@/services/oxy-services';
import { GATEWAY_SOCKET_URL } from '@/config';

/**
 * Typed Gateway event contract (mirrors `packages/backend/src/realtime/socket.ts`).
 * Typing the socket lets `intent.updated` payloads and the `subscribe` ack flow
 * through without any casts.
 */
interface ServerToClientEvents {
  'intent.updated': (intent: PaymentIntent) => void;
}

interface ClientToServerEvents {
  subscribe: (
    payload: { intentId: string; clientSecret: string },
    ack: (result: { ok: boolean }) => void,
  ) => void;
}

/**
 * Single lazy connection to the Peable Gateway realtime layer.
 *
 * `autoConnect: false` gates dialing the Gateway on being authenticated: the
 * handshake carries the Oxy access token (`handshake.auth.token`, read by the
 * Gateway's `oxy.middleware.socket()`), and a signed-out boot has no token to
 * present. `subscribeToIntent` opens the connection only after checking the
 * session. The `auth` callback is re-read on every (re)connect, so a rotated
 * token is always sent fresh rather than captured stale at construction.
 */
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  GATEWAY_SOCKET_URL,
  {
    transports: ['websocket'],
    autoConnect: false,
    auth: (cb) => cb({ token: oxyServices.session.accessToken ?? '' }),
  },
);

/** Handle returned by {@link subscribeToIntent} to stop receiving updates. */
export interface IntentSubscription {
  unsubscribe(): void;
}

/**
 * Subscribe to live status changes for one payment intent.
 *
 * Emits `subscribe {intentId, clientSecret}` and awaits the Gateway's `{ok}`
 * ack (which also proves possession of the intent's `client_secret`), then
 * invokes `onUpdate` for every `intent.updated` broadcast for this intent.
 * Connection is gated on an authenticated Oxy session — the Gateway rejects an
 * unauthenticated handshake, so there is nothing to subscribe to while signed out.
 */
export async function subscribeToIntent(
  intentId: string,
  clientSecret: string,
  onUpdate: (intent: PaymentIntent) => void,
): Promise<IntentSubscription> {
  if (!oxyServices.session.accessToken) {
    throw new Error(
      'Cannot subscribe to a payment intent while signed out of Oxy',
    );
  }

  if (!socket.connected) {
    socket.connect();
  }

  const ack = await socket.emitWithAck('subscribe', { intentId, clientSecret });
  if (!ack.ok) {
    throw new Error(`Gateway rejected subscription to payment intent ${intentId}`);
  }

  // The socket may carry several intent subscriptions at once; filter to this
  // one so each caller's `onUpdate` fires only for its own intent.
  const listener = (intent: PaymentIntent): void => {
    if (intent.id === intentId) {
      onUpdate(intent);
    }
  };
  socket.on('intent.updated', listener);

  return {
    unsubscribe(): void {
      socket.off('intent.updated', listener);
    },
  };
}
