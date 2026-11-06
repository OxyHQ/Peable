/**
 * The payer socket answers ANY origin without credentials; the Oxy socket
 * keeps `createOxySocketCors` (`realtime/socket.ts`, `server.ts`).
 *
 * Both ways, over the real gateway and real `socket.io-client` connections:
 *
 *  - a merchant's own site (a foreign origin) opens the payer socket on both
 *    transports, subscribes with the intent's client secret and hears the
 *    payment move — and a wrong secret, a handshake token or an
 *    `Authorization` header gets nothing;
 *  - the same foreign origin is refused by the Oxy socket on both transports,
 *    while an Oxy origin carrying an identity still connects there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { PAYER_SOCKET_PATH } from '@peable.to/contracts/vocabulary';
import { io as ioClient, type Socket } from 'socket.io-client';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
import {
  gatewayDb,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { must } from '../../__tests__/helpers/must';
import { createGateway, type Gateway } from '../../server';
import { emitIntentUpdateToActive, intentRoom } from '../socket';

const FOREIGN = 'https://shop.merchant-example.com';
const OXY = 'https://checkout.peable.to';
const INTENT_ID = 'pi_payer_socket_test_000001';
const CLIENT_SECRET = 'pi_payer_socket_test_000001_secret_abcdef';

const stubSocketAuth = (socket: unknown, next: (err?: Error) => void): void => {
  (socket as { data?: Record<string, unknown> }).data = { userId: 'payer_socket_test_user' };
  next();
};

let gateway: Gateway;
let base = '';
const opened: Socket[] = [];

useGatewayDatabase();

beforeAll(async () => {
  const merchant = await seedMerchant({
    publicId: 'merch_payer_socket_test',
    oxyAppId: 'app_payer_socket_test',
    environment: 'development',
    network: 'testnet',
  });
  await seedIntent(merchant, {
    publicId: INTENT_ID,
    amount: '100000000',
    network: 'testnet',
    address: 'TPayerSocketTestAddress0000000001',
    clientSecret: CLIENT_SECRET,
    idempotencyKey: 'idem_payer_socket_test',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  gateway = createGateway({ socketAuth: stubSocketAuth });
  await new Promise<void>((resolve) => gateway.httpServer.listen(0, resolve));
  base = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  for (const socket of opened) socket.close();
  gateway.payerIo.disconnectSockets(true);
  gateway.payerIo.engine.close();
  gateway.io.close();
  gateway.httpServer.close();
});

function withTimeout<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    }),
  ]);
}

function open(options: {
  payer: boolean;
  origin: string;
  transport: 'websocket' | 'polling';
  token?: string;
  authorization?: string;
}): Socket {
  const socket = ioClient(base, {
    path: options.payer ? PAYER_SOCKET_PATH : undefined,
    transports: [options.transport],
    forceNew: true,
    reconnection: false,
    extraHeaders: {
      Origin: options.origin,
      ...(options.authorization ? { Authorization: options.authorization } : {}),
    },
    ...(options.token ? { auth: { token: options.token } } : {}),
  });
  opened.push(socket);
  return socket;
}

/** `'connected'`, or the refusal's message. */
function outcome(socket: Socket): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      if (socket.connected) resolve('connected');
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', (error: Error) => resolve(`refused: ${error.message}`));
    }),
    'connect outcome',
  );
}

function subscribe(socket: Socket, clientSecret: string): Promise<{ ok: boolean }> {
  return withTimeout(
    socket.emitWithAck('subscribe', { intent_id: INTENT_ID, client_secret: clientSecret }),
    'subscribe ack',
  );
}

/** The engine.io polling handshake, as a browser on `origin` would make it. */
function pollingHandshake(path: string, origin: string): Promise<Response> {
  return fetch(`${base}${path}/?EIO=4&transport=polling`, { headers: { Origin: origin } });
}

describe('the payer socket, from a merchant site', () => {
  test.each(['websocket', 'polling'] as const)(
    'connects over %s, subscribes with the client secret and hears the payment move',
    async (transport) => {
      const socket = open({ payer: true, origin: FOREIGN, transport });
      expect(await outcome(socket)).toBe('connected');
      expect((await subscribe(socket, CLIENT_SECRET)).ok).toBe(true);

      const update = withTimeout(
        new Promise<{ id: string }>((resolve) => socket.on('intent.updated', resolve)),
        'intent.updated',
      );
      emitIntentUpdateToActive(must(await findIntentByPublicId(gatewayDb(), INTENT_ID)));
      expect((await update).id).toBe(INTENT_ID);
      socket.close();
    },
  );

  test('a wrong client secret joins no room', async () => {
    const socket = open({ payer: true, origin: FOREIGN, transport: 'websocket' });
    expect(await outcome(socket)).toBe('connected');
    expect((await subscribe(socket, 'wrong-secret')).ok).toBe(false);
    const room = gateway.payerIo.sockets.adapter.rooms.get(intentRoom(INTENT_ID));
    expect(room?.has(must(socket.id)) ?? false).toBe(false);
    socket.close();
  });

  test('a handshake token is refused: an identity belongs on the Oxy socket', async () => {
    const socket = open({ payer: true, origin: FOREIGN, transport: 'websocket', token: 'tok' });
    expect(await outcome(socket)).toBe('refused: the payer socket takes no credentials');
  });

  test('an Authorization header is refused', async () => {
    const socket = open({
      payer: true,
      origin: FOREIGN,
      transport: 'polling',
      authorization: 'Bearer tok',
    });
    expect(await outcome(socket)).toBe('refused: the payer socket takes no credentials');
  });

  test('long-polling answers any origin, never with credentials', async () => {
    const response = await pollingHandshake(PAYER_SOCKET_PATH, FOREIGN);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    await response.text();
  });
});

describe('the Oxy socket keeps the Oxy origins', () => {
  test.each(['websocket', 'polling'] as const)(
    'refuses a merchant site over %s',
    async (transport) => {
      const socket = open({ payer: false, origin: FOREIGN, transport });
      expect(await outcome(socket)).toStartWith('refused');
    },
  );

  test('long-polling never admits a merchant site', async () => {
    const response = await pollingHandshake('/socket.io', FOREIGN);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.status).not.toBe(200);
    await response.text();
  });

  test('an Oxy origin with an identity still connects and subscribes', async () => {
    const socket = open({ payer: false, origin: OXY, transport: 'websocket', token: 'tok' });
    expect(await outcome(socket)).toBe('connected');
    expect((await subscribe(socket, CLIENT_SECRET)).ok).toBe(true);
    socket.close();
  });

  test('a payment update reaches both servers', async () => {
    const payer = open({ payer: true, origin: FOREIGN, transport: 'websocket' });
    const wallet = open({ payer: false, origin: OXY, transport: 'websocket', token: 'tok' });
    expect(await outcome(payer)).toBe('connected');
    expect(await outcome(wallet)).toBe('connected');
    expect((await subscribe(payer, CLIENT_SECRET)).ok).toBe(true);
    expect((await subscribe(wallet, CLIENT_SECRET)).ok).toBe(true);
    const heard = (socket: Socket) =>
      withTimeout(
        new Promise<string>((resolve) =>
          socket.on('intent.updated', (intent: { id: string }) => resolve(intent.id)),
        ),
        'intent.updated',
      );
    const both = Promise.all([heard(payer), heard(wallet)]);
    emitIntentUpdateToActive(must(await findIntentByPublicId(gatewayDb(), INTENT_ID)));
    expect(await both).toEqual([INTENT_ID, INTENT_ID]);
    payer.close();
    wallet.close();
  });
});
