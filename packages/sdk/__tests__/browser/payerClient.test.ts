/**
 * `createPeableCheckout` — the anonymous payer-side client core (Fase 2 SDK
 * plan, Task 5). REST calls (`getPaymentIntent`/`submitTx`) are exercised
 * against a stubbed `globalThis.fetch` (the SDK's shared `createMockFetch`
 * harness); `subscribe` is exercised against a mock `socket.io-client`
 * installed via `mock.module` BEFORE importing the module under test, since
 * `payerClient.ts` imports `io` at module scope.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { PaymentIntent } from '@peable.to/shared-types';
import { createMockFetch } from '../support/mockFetch';
import { TEST_GATEWAY_URL } from '../support/testGateway';

interface FakeManager {
  on: ReturnType<typeof mock>;
  off: ReturnType<typeof mock>;
}

interface FakeSocket {
  emitWithAck: ReturnType<typeof mock>;
  on: ReturnType<typeof mock>;
  off: ReturnType<typeof mock>;
  disconnect: ReturnType<typeof mock>;
  io: FakeManager;
}

let nextSocket: FakeSocket | null = null;
const ioCalls: Array<{ url: string; opts: unknown }> = [];

/**
 * `ack` is either a fixed ack/error (every `emitWithAck` call resolves the
 * same way) or a queue consumed one entry per call — the reconnect test needs
 * the SECOND `emitWithAck` (the resubscribe) to be distinguishable from the
 * first.
 */
function installFakeSocket(
  ack: { ok: boolean } | Error | Array<{ ok: boolean } | Error>,
): FakeSocket {
  const queue = Array.isArray(ack) ? [...ack] : null;
  const socket: FakeSocket = {
    emitWithAck: mock(async () => {
      if (!queue) {
        if (ack instanceof Error) throw ack;
        return ack;
      }
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('installFakeSocket() ack queue exhausted — emitWithAck called too many times');
      }
      if (next instanceof Error) throw next;
      return next;
    }),
    on: mock(() => {}),
    off: mock(() => {}),
    disconnect: mock(() => {}),
    io: { on: mock(() => {}), off: mock(() => {}) },
  };
  nextSocket = socket;
  return socket;
}

// Mock socket.io-client BEFORE importing the module under test (bun:test
// convention — see `gateway-client.test.ts`/`identity-wallet.test.ts`).
mock.module('socket.io-client', () => ({
  io: (url: string, opts: unknown) => {
    ioCalls.push({ url, opts });
    if (!nextSocket) throw new Error('installFakeSocket() was not called for this test');
    return nextSocket;
  },
}));

const { createPeableCheckout } = await import('../../src/browser/payerClient');
const { PeableApiError, PeableInvalidRequestError, PeablePermissionError } = await import(
  '../../src/core/errors'
);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  nextSocket = null;
  ioCalls.length = 0;
});

const INTENT: PaymentIntent = {
  id: 'pi_1',
  object: 'payment_intent',
  status: 'created',
  rail: 'faircoin',
  amount: '100',
  currency: 'FAIR',
  network: 'testnet',
  address: 'TAddr1',
  merchantId: 'merch_1',
  txid: null,
  confirmations: 0,
  clientSecret: 'secret_1',
  metadata: {},
  expiresAt: '2026-07-20T00:00:00.000Z',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
};

describe('getPaymentIntent', () => {
  test('GETs /v1/payment_intents/:id with client_secret as the X-Peable-Client-Secret header and returns the DTO', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: INTENT,
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    const result = await client.getPaymentIntent('pi_1', 'secret_1');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1`);
    expect(requests[0]?.url).not.toContain('client_secret');
    expect(requests[0]?.headers.get('X-Peable-Client-Secret')).toBe('secret_1');
    expect(result).toEqual(INTENT);
  });

  test('URL-encodes the id and never puts client_secret in the URL', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({ status: 200, json: INTENT }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await client.getPaymentIntent('pi/1', 'sec ret');

    const url = new URL(requests[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/payment_intents/pi%2F1');
    expect(url.search).toBe('');
    expect(requests[0]?.headers.get('X-Peable-Client-Secret')).toBe('sec ret');
  });

  test('defaults gatewayUrl to https://api.peable.to when not given', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({ status: 200, json: INTENT }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout();

    await client.getPaymentIntent('pi_1', 'secret_1');

    expect(requests[0]?.url).toStartWith('https://api.peable.to/v1/payment_intents/pi_1');
  });

  test('maps a 403 invalid client_secret response to PeablePermissionError', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 403,
      json: { error: { type: 'permission_error', message: 'invalid client_secret' } },
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await expect(client.getPaymentIntent('pi_1', 'wrong')).rejects.toBeInstanceOf(
      PeablePermissionError,
    );
  });

  test('maps a 404 not-found response to PeableInvalidRequestError', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 404,
      json: { error: { type: 'invalid_request_error', message: 'payment intent not found' } },
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await expect(client.getPaymentIntent('pi_missing', 'secret_1')).rejects.toBeInstanceOf(
      PeableInvalidRequestError,
    );
  });

  test('wraps a network-level fetch failure as PeableApiError', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await expect(client.getPaymentIntent('pi_1', 'secret_1')).rejects.toBeInstanceOf(
      PeableApiError,
    );
  });
});

describe('submitTx', () => {
  test('POSTs /v1/payment_intents/:id/submit_tx with {client_secret, txid} and returns the DTO', async () => {
    const broadcast: PaymentIntent = { ...INTENT, status: 'broadcast', txid: 'tx_abc' };
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: broadcast,
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    const result = await client.submitTx('pi_1', 'secret_1', 'tx_abc');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/submit_tx`);
    expect(requests[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      client_secret: 'secret_1',
      txid: 'tx_abc',
    });
    expect(result).toEqual(broadcast);
  });

  test('maps a 409 illegal state transition response to PeableInvalidRequestError', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 409,
      json: { error: { type: 'invalid_request_error', message: 'illegal state transition' } },
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await expect(client.submitTx('pi_1', 'secret_1', 'tx_abc')).rejects.toBeInstanceOf(
      PeableInvalidRequestError,
    );
  });

  test('wraps a network-level fetch failure as PeableApiError', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await expect(client.submitTx('pi_1', 'secret_1', 'tx_abc')).rejects.toBeInstanceOf(
      PeableApiError,
    );
  });
});

describe('subscribe', () => {
  test('connects anonymously (no auth option) and emits subscribe with {intentId, clientSecret}', async () => {
    const socket = installFakeSocket({ ok: true });
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await client.subscribe('pi_1', 'secret_1', () => {});

    expect(ioCalls).toHaveLength(1);
    expect(ioCalls[0]?.url).toBe(TEST_GATEWAY_URL);
    expect(ioCalls[0]?.opts).toEqual({ transports: ['websocket'] });
    expect(socket.emitWithAck).toHaveBeenCalledWith('subscribe', {
      intentId: 'pi_1',
      clientSecret: 'secret_1',
    });
  });

  test('calls onUpdate only for intent.updated events matching this intent id', async () => {
    const socket = installFakeSocket({ ok: true });
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });
    const updates: PaymentIntent[] = [];

    await client.subscribe('pi_1', 'secret_1', (intent) => updates.push(intent));

    const listener = socket.on.mock.calls[0]?.[1] as (intent: PaymentIntent) => void;
    expect(socket.on.mock.calls[0]?.[0]).toBe('intent.updated');

    listener({ ...INTENT, id: 'pi_OTHER', status: 'broadcast' });
    listener({ ...INTENT, id: 'pi_1', status: 'broadcast' });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe('pi_1');
    expect(updates[0]?.status).toBe('broadcast');
  });

  test('unsubscribe removes the listener, removes the reconnect handler, and disconnects the socket', async () => {
    const socket = installFakeSocket({ ok: true });
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    const { unsubscribe } = await client.subscribe('pi_1', 'secret_1', () => {});
    const listener = socket.on.mock.calls[0]?.[1];
    const reconnectHandler = socket.io.on.mock.calls[0]?.[1];

    unsubscribe();

    expect(socket.off).toHaveBeenCalledWith('intent.updated', listener);
    expect(socket.io.off).toHaveBeenCalledWith('reconnect', reconnectHandler);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  test('on Manager reconnect, re-emits subscribe with the same {intentId, clientSecret} without duplicating the intent.updated listener', async () => {
    const socket = installFakeSocket([{ ok: true }, { ok: true }]);
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });
    const updates: PaymentIntent[] = [];

    await client.subscribe('pi_1', 'secret_1', (intent) => updates.push(intent));

    expect(socket.io.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
    const reconnectHandler = socket.io.on.mock.calls[0]?.[1] as () => void;

    reconnectHandler();
    // The resubscribe fires fire-and-forget — flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
    expect(socket.emitWithAck).toHaveBeenNthCalledWith(2, 'subscribe', {
      intentId: 'pi_1',
      clientSecret: 'secret_1',
    });
    // `intent.updated` must still be registered exactly once — a reconnect
    // must never re-add the listener (which would double-fire onUpdate).
    //
    // Counted BY EVENT NAME rather than as a total `socket.on` count. The total
    // was a proxy that held only while `intent.updated` was the sole listener,
    // and it went red when a `disconnect` listener was added beside it — for a
    // change that does not touch the property this case is about. A proxy that
    // fails on unrelated work is one somebody eventually deletes.
    const intentUpdatedCalls = socket.on.mock.calls.filter(
      ([event]) => event === 'intent.updated',
    );
    expect(intentUpdatedCalls).toHaveLength(1);

    const listener = intentUpdatedCalls[0]?.[1] as (intent: PaymentIntent) => void;
    listener({ ...INTENT, id: 'pi_1', status: 'broadcast' });
    expect(updates).toHaveLength(1);
  });

  test('a failed resubscribe on reconnect is swallowed (no unhandled rejection, no throw)', async () => {
    const socket = installFakeSocket([
      { ok: true },
      new Error('intent has since expired'),
    ]);
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await client.subscribe('pi_1', 'secret_1', () => {});
    const reconnectHandler = socket.io.on.mock.calls[0]?.[1] as () => void;

    expect(() => reconnectHandler()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
  });

  test('a rejected ack (ok: false) disconnects the socket and throws PeableInvalidRequestError', async () => {
    const socket = installFakeSocket({ ok: false });
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await expect(client.subscribe('pi_1', 'wrong-secret', () => {})).rejects.toBeInstanceOf(
      PeableInvalidRequestError,
    );
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.on).not.toHaveBeenCalled();
  });

  test('an emitWithAck failure disconnects the socket and throws PeableApiError', async () => {
    const socket = installFakeSocket(new Error('socket disconnected before ack'));
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await expect(client.subscribe('pi_1', 'secret_1', () => {})).rejects.toBeInstanceOf(
      PeableApiError,
    );
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * A drop AFTER `subscribe` resolves.
   *
   * Nothing could observe one before: the promise had already settled, so its
   * `.catch` could not fire again, and socket.io reconnects the transport
   * silently while replaying NO frames. A payment that settled during the gap
   * therefore never reached the page and never would.
   */
  test('reports a drop after subscribe resolved', async () => {
    const socket = installFakeSocket({ ok: true });
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });
    const states: string[] = [];

    await client.subscribe('pi_1', 'secret_1', () => {}, (state) => states.push(state));

    const disconnectHandler = socket.on.mock.calls.find(
      ([event]) => event === 'disconnect',
    )?.[1] as () => void;
    expect(disconnectHandler).toBeInstanceOf(Function);

    disconnectHandler();
    expect(states).toEqual(['lost']);
  });

  /**
   * `'live'` follows the ROOM rejoin, not the transport.
   *
   * The server spins up a fresh Socket on reconnect with no room membership, so
   * a connected socket that has not rejoined delivers nothing — and a host told
   * it was live there would stand its fallback down into permanent silence.
   */
  test('reports live only after the room is rejoined', async () => {
    const socket = installFakeSocket([{ ok: true }, { ok: true }]);
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });
    const states: string[] = [];

    await client.subscribe('pi_1', 'secret_1', () => {}, (state) => states.push(state));
    const reconnectHandler = socket.io.on.mock.calls[0]?.[1] as () => void;

    reconnectHandler();
    // Before the resubscribe ack settles, nothing has been claimed.
    expect(states).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();

    expect(states).toEqual(['live']);
  });

  /**
   * A resubscribe the gateway REFUSES (the intent expired between drop and
   * reconnect) leaves the caller `lost`. Reporting `live` off the transport
   * alone would be the same permanent silence.
   */
  test('stays lost when the rejoin is refused', async () => {
    const socket = installFakeSocket([{ ok: true }, { ok: false }]);
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });
    const states: string[] = [];

    await client.subscribe('pi_1', 'secret_1', () => {}, (state) => states.push(state));
    const reconnectHandler = socket.io.on.mock.calls[0]?.[1] as () => void;

    reconnectHandler();
    await Promise.resolve();
    await Promise.resolve();

    expect(states).toEqual([]);
  });

  /**
   * The deliberate close must NOT look like a drop. `unsubscribe` disconnects,
   * which fires `disconnect` like any other close — reporting `'lost'` there
   * would have a host spin up a fallback for a subscription it just tore down,
   * on an unmounting component.
   */
  test('unsubscribing does not report a lost connection', async () => {
    const socket = installFakeSocket({ ok: true });
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });
    const states: string[] = [];

    const subscription = await client.subscribe(
      'pi_1',
      'secret_1',
      () => {},
      (state) => states.push(state),
    );
    const disconnectHandler = socket.on.mock.calls.find(
      ([event]) => event === 'disconnect',
    )?.[1] as () => void;

    subscription.unsubscribe();
    // Whether or not the fake re-fires it, a close we asked for is not a drop.
    disconnectHandler();

    expect(states).toEqual([]);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * Vacuity floor for the four cases above: a caller that passes no callback
   * behaves exactly as it did, which is what makes the parameter additive on a
   * published package rather than a change every consumer must absorb.
   */
  test('a subscriber that wants no connection reports still works', async () => {
    const socket = installFakeSocket({ ok: true });
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });
    const updates: PaymentIntent[] = [];

    await client.subscribe('pi_1', 'secret_1', (intent) => updates.push(intent));

    const disconnectHandler = socket.on.mock.calls.find(
      ([event]) => event === 'disconnect',
    )?.[1] as () => void;
    expect(() => disconnectHandler()).not.toThrow();

    const listener = socket.on.mock.calls.find(([event]) => event === 'intent.updated')?.[1] as (
      intent: PaymentIntent,
    ) => void;
    listener({ ...INTENT, id: 'pi_1', status: 'broadcast' });
    expect(updates).toHaveLength(1);
  });
});
