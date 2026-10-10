/**
 * Integration coverage for the two anonymous-surface throttles added to
 * `initSocket` (sec-realtime MINOR — see `socket.ts`'s throttling doc block
 * above `FixedWindowLimiter`): a per-IP cap on new connections and a
 * per-socket cap on `subscribe` calls. Runs a real `SocketServer` +
 * `socket.io-client` against its own throwaway Postgres database — a SEPARATE
 * server/gateway from `__tests__/e2e.test.ts`'s, so neither file's
 * connection/subscribe volume can exhaust the other's limiter budget.
 * `optionalSocketAuth` itself (the identity-optional connection gate) is
 * already covered in isolation by `socket.test.ts`.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
import {
  gatewayDb,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { initSocket, emitIntentUpdate, IP_CONNECT_MAX, SUBSCRIBE_MAX_PER_WINDOW } from '../socket';

const INTENT_ID = 'pi_throttle_test_0000000001';
const CLIENT_SECRET = 'pi_throttle_test_0000000001_secret_abcdef';

// Identity verifier for a handshake that DOES present a token — trivially
// accepts, mirroring `__tests__/e2e.test.ts`'s `stubSocketAuth`.
const stubSocketAuth = (socket: unknown, next: (err?: Error) => void): void => {
  (socket as { data?: Record<string, unknown> }).data = { userId: 'throttle_test_user' };
  next();
};

let httpServer: HttpServer;
let io: SocketServer;
let baseUrl: string;

useGatewayDatabase();

beforeAll(async () => {
  // The intent now REFERENCES its merchant (`payment_intents_merchant_id_network_fkey`),
  // so a free-form `merch_throttle_test` string is not a value the database
  // accepts — the fixture registers a real merchant first.
  const merchant = await seedMerchant({
    publicId: 'merch_throttle_test',
    oxyAppId: 'app_throttle_test',
    environment: 'development',
    network: 'testnet',
  });

  await seedIntent(merchant, {
    publicId: INTENT_ID,
    amount: '100000000',
    network: 'testnet',
    address: 'TThrottleTestAddress00000000000001',
    clientSecret: CLIENT_SECRET,
    idempotencyKey: 'idem_throttle_test',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  httpServer = createServer();
  io = new SocketServer(httpServer);
  initSocket(io, { socketAuth: stubSocketAuth });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('http server did not bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  io.close();
  httpServer.close();
});

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    }),
  ]);
}

type ClientSocket = ReturnType<typeof ioClient>;

type ConnectResult = { connected: true; socket: ClientSocket } | { connected: false; error: Error };

/**
 * Open one client connection tagged with a synthetic `X-Forwarded-For` IP
 * (see `resolveClientIp` in `socket.ts`), resolving once it either connects
 * or is rejected by the connection middleware chain. Every test below uses
 * its OWN distinct IP so the per-IP throttle test's budget-exhausting run
 * can never affect another test, regardless of `bun test --randomize` order.
 */
function attemptConnect(ip: string, token?: string): Promise<ConnectResult> {
  const socket = ioClient(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: { 'x-forwarded-for': ip },
    ...(token !== undefined ? { auth: { token } } : {}),
  });
  return withTimeout(
    new Promise<ConnectResult>((resolve) => {
      socket.once('connect', () => resolve({ connected: true, socket }));
      socket.once('connect_error', (error: Error) => resolve({ connected: false, error }));
    }),
    5000,
    `connect attempt from ${ip}`,
  );
}

test('normal flow: a single connection and a single subscribe succeed', async () => {
  const result = await attemptConnect('203.0.113.10');
  if (!result.connected) {
    throw new Error(`expected connect, got error: ${result.error.message}`);
  }

  const ack = await result.socket.emitWithAck('subscribe', {
    intentId: INTENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  expect(ack.ok).toBe(true);

  result.socket.disconnect();
});

test('authed flow: a connection presenting a valid identity token still connects and subscribes', async () => {
  const result = await attemptConnect('203.0.113.11', 'valid-token');
  if (!result.connected) {
    throw new Error(`expected connect, got error: ${result.error.message}`);
  }

  const ack = await result.socket.emitWithAck('subscribe', {
    intentId: INTENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  expect(ack.ok).toBe(true);

  result.socket.disconnect();
});

test('per-IP throttle: connections up to IP_CONNECT_MAX succeed, the next one from the same IP is rejected', async () => {
  const ip = '203.0.113.12';

  for (let i = 0; i < IP_CONNECT_MAX; i += 1) {
    const result = await attemptConnect(ip);
    if (!result.connected) {
      throw new Error(
        `connection ${i + 1}/${IP_CONNECT_MAX} unexpectedly rejected: ${result.error.message}`,
      );
    }
    result.socket.disconnect();
  }

  const overCap = await attemptConnect(ip);
  expect(overCap.connected).toBe(false);
  if (overCap.connected) throw new Error('unreachable');
  expect(overCap.error.message).toMatch(/too many connections/);
});

test("per-IP throttle: a forged X-Forwarded-For prefix claiming to be another IP never consumes that IP's budget", async () => {
  const victimIp = '203.0.113.40';
  const attackerObservedIp = '203.0.113.41';

  // A real single-hop ALB in front of this gateway never trusts or strips a
  // client-supplied X-Forwarded-For prefix — it APPENDS the address it
  // itself observed for its direct peer to the right. So an attacker who
  // sends `X-Forwarded-For: <victimIp>` in an attempt to frame the victim's
  // bucket produces exactly this raw header on the wire: the forged claim on
  // the left, the attacker's own real (ALB-observed) address on the right —
  // which is exactly what `attemptConnect` puts on the wire when passed this
  // literal string as the header value.
  const forgedHeader = `${victimIp}, ${attackerObservedIp}`;

  // Every one of these must land in the ATTACKER's own (rightmost) bucket,
  // never the victim's — proving the forged left prefix is inert.
  for (let i = 0; i < IP_CONNECT_MAX; i += 1) {
    const result = await attemptConnect(forgedHeader);
    if (!result.connected) {
      throw new Error(
        `forged-prefix connection ${i + 1}/${IP_CONNECT_MAX} unexpectedly rejected: ${result.error.message}`,
      );
    }
    result.socket.disconnect();
  }
  const attackerOverCap = await attemptConnect(forgedHeader);
  expect(attackerOverCap.connected).toBe(false); // the ATTACKER's real-IP bucket is now spent

  // The real victim — a single-hop, honest header (just their own IP, as the
  // ALB would actually report it) — is completely unaffected: their budget
  // was never touched by the attacker's forged claim.
  const victim = await attemptConnect(victimIp);
  if (!victim.connected) {
    throw new Error(`victim's real connection unexpectedly rejected: ${victim.error.message}`);
  }
  victim.socket.disconnect();
});

test('per-socket subscribe throttle: exceeding the cap rejects further subscribes but keeps the socket connected and earlier room joins intact', async () => {
  const result = await attemptConnect('203.0.113.13');
  if (!result.connected) {
    throw new Error(`expected connect, got error: ${result.error.message}`);
  }
  const { socket } = result;

  // Spend the whole per-socket budget on otherwise-valid subscribe calls.
  for (let i = 0; i < SUBSCRIBE_MAX_PER_WINDOW; i += 1) {
    const ack = await socket.emitWithAck('subscribe', {
      intentId: INTENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(ack.ok).toBe(true);
  }

  // One more is over budget — throttled, not a capability failure.
  const throttledAck = await socket.emitWithAck('subscribe', {
    intentId: INTENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  expect(throttledAck.ok).toBe(false);
  expect(socket.connected).toBe(true);

  // The room join from the first (within-budget) subscribe still holds —
  // the throttled call rejected only ITSELF, nothing already granted.
  const intent = await findIntentByPublicId(gatewayDb(), INTENT_ID);
  if (!intent) throw new Error('fixture intent missing');

  const updatePromise = withTimeout(
    new Promise<{ id: string }>((resolve) => {
      socket.once('intent.updated', resolve);
    }),
    2000,
    'intent.updated after throttled subscribe',
  );
  emitIntentUpdate(io, intent);
  const update = await updatePromise;
  expect(update.id).toBe(INTENT_ID);

  socket.disconnect();
});
