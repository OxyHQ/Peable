import type { OxyServices } from '@oxy.so/core';
import type { PaymentIntent } from '@peable.to/shared-types';
import { io, type Socket } from 'socket.io-client';

interface ServerEvents {
  'intent.updated': (intent: PaymentIntent) => void;
}
interface ClientEvents {
  subscribe: (
    payload: { intentId: string; clientSecret: string },
    ack: (result: { ok: boolean }) => void,
  ) => void;
}
export interface IntentSubscription {
  unsubscribe(): void;
}

/** One account owns this connection and its intent capability for its whole lifetime. */
export function openIntentSubscription(
  oxy: OxyServices,
  baseURL: string,
  intentId: string,
  clientSecret: string,
  onUpdate: (intent: PaymentIntent) => void,
  signal?: AbortSignal,
): Promise<IntentSubscription> {
  const linked = oxy.createLinkedClient({ baseURL });
  const epoch = linked.client.getSessionEpoch();
  const controller = new AbortController();
  let closed = false;
  let settled = false;
  let joined = false;
  let generation = 0;
  let unwatch: (() => void) | undefined;
  let rejectOpening: (error: Error) => void = () => {};
  const current = () => !closed && linked.client.getSessionEpoch() === epoch;
  const socket: Socket<ServerEvents, ClientEvents> = io(baseURL, {
    autoConnect: false,
    forceNew: true,
    transports: ['websocket'],
    auth: (callback) => {
      void linked.getAccessToken(baseURL, { signal: controller.signal }).then(
        (token) => {
          if (current()) callback({ token });
        },
        () => close(new Error('The Oxy session is no longer available')),
      );
    },
  });
  const close = (error = new Error('Payment subscription closed')) => {
    if (closed) return;
    closed = true;
    joined = false;
    controller.abort();
    clearTimeout(openingTimeout);
    signal?.removeEventListener('abort', abort);
    unwatch?.();
    socket.removeAllListeners();
    socket.disconnect();
    linked.dispose();
    if (!settled) {
      settled = true;
      rejectOpening(error);
    }
  };
  const abort = () => close(new Error('Payment subscription cancelled'));
  const openingTimeout = setTimeout(
    () => close(new Error('Payment subscription timed out')),
    15_000,
  );
  const result = new Promise<IntentSubscription>((resolve, reject) => {
    rejectOpening = reject;
    // Keep this handler after the initial acknowledgement: every reconnect loses rooms.
    socket.on('connect', () => {
      if (!current()) return close();
      joined = false;
      const attempt = ++generation;
      void socket
        .timeout(10_000)
        .emitWithAck('subscribe', { intentId, clientSecret })
        .then(
          (ack) => {
            if (!current() || attempt !== generation || !socket.connected) return;
            if (!ack.ok) return close(new Error('Gateway rejected the payment subscription'));
            joined = true;
            if (!settled) {
              settled = true;
              clearTimeout(openingTimeout);
              resolve({ unsubscribe: () => close() });
            }
          },
          () => {
            if (current() && attempt === generation)
              close(new Error('Gateway did not acknowledge the payment subscription'));
          },
        );
    });
    socket.on('disconnect', () => {
      joined = false;
      generation += 1;
    });
    socket.on('connect_error', () => close(new Error('Gateway connection failed')));
    socket.on('intent.updated', (intent) => {
      if (current() && joined && intent.id === intentId) onUpdate(intent);
    });
  });
  unwatch = linked.client.addTokenChangeListener(() => {
    if (!current()) close(new Error('The Oxy account changed'));
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  else if (!current()) close();
  else socket.connect();
  return result;
}
