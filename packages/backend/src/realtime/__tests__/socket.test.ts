/**
 * `optionalSocketAuth` is the ROOT of the capability-based realtime model:
 * it decides whether a connection needs identity at all. These tests pin
 * that decision down in isolation (no real `oxy`, no database) so the
 * capability semantics can't silently regress underneath the `subscribe`
 * capability check, which is covered end-to-end in `__tests__/e2e.test.ts`.
 *
 * The `FixedWindowLimiter` / `socketClientIp` / `ipConnectionThrottle`
 * tests below cover the throttling ALGORITHM in isolation (no real socket,
 * no server); the full wiring (real connections actually getting rejected,
 * `subscribe` actually getting throttled while the socket stays alive) is
 * covered end-to-end in `__tests__/throttle.test.ts`.
 */
import { test, expect } from 'bun:test';
import {
  optionalSocketAuth,
  type SocketAuth,
  FixedWindowLimiter,
  socketClientIp,
  ipConnectionThrottle,
} from '../socket';

function fakeSocket(auth: Record<string, unknown> = {}): unknown {
  return { handshake: { auth } };
}

test('optionalSocketAuth: no handshake token connects anonymously without invoking the identity verifier', async () => {
  let called = false;
  const requireIdentity: SocketAuth = (_socket, next) => {
    called = true;
    next();
  };

  let err: Error | undefined;
  await optionalSocketAuth(requireIdentity)(fakeSocket(), (e) => {
    err = e;
  });

  expect(called).toBe(false);
  expect(err).toBeUndefined();
});

test('optionalSocketAuth: an empty-string token is treated the same as no token (anonymous, verifier not invoked)', async () => {
  let called = false;
  const requireIdentity: SocketAuth = (_socket, next) => {
    called = true;
    next();
  };

  let err: Error | undefined;
  await optionalSocketAuth(requireIdentity)(fakeSocket({ token: '' }), (e) => {
    err = e;
  });

  expect(called).toBe(false);
  expect(err).toBeUndefined();
});

test('optionalSocketAuth: a non-string token is treated as absent (anonymous, verifier not invoked)', async () => {
  let called = false;
  const requireIdentity: SocketAuth = (_socket, next) => {
    called = true;
    next();
  };

  let err: Error | undefined;
  await optionalSocketAuth(requireIdentity)(fakeSocket({ token: 12345 }), (e) => {
    err = e;
  });

  expect(called).toBe(false);
  expect(err).toBeUndefined();
});

test('optionalSocketAuth: a present token is verified by the wrapped identity middleware and accepted through', async () => {
  const socket = fakeSocket({ token: 'valid-token' });
  let seenSocket: unknown;
  const requireIdentity: SocketAuth = (s, next) => {
    seenSocket = s;
    next();
  };

  let err: Error | undefined;
  await optionalSocketAuth(requireIdentity)(socket, (e) => {
    err = e;
  });

  expect(seenSocket).toBe(socket);
  expect(err).toBeUndefined();
});

test('optionalSocketAuth: a present but INVALID token is rejected outright — never silently downgraded to anonymous', async () => {
  const requireIdentity: SocketAuth = (_socket, next) => {
    next(new Error('Invalid token'));
  };

  let err: Error | undefined;
  await optionalSocketAuth(requireIdentity)(fakeSocket({ token: 'forged' }), (e) => {
    err = e;
  });

  expect(err).toBeInstanceOf(Error);
  expect(err?.message).toBe('Invalid token');
});

/** A socket.io socket as `socketClientIp` sees it: the handshake's raw Node request. */
function fakeSocketWithHeaders(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress = '10.0.0.1',
): unknown {
  return { request: { headers, socket: { remoteAddress } } };
}

test('socketClientIp: no X-Forwarded-For header answers the raw transport address', () => {
  expect(socketClientIp(fakeSocketWithHeaders({}))).toBe('10.0.0.1');
});

test('socketClientIp: DNS-only hostname — the ALB (private peer) appended the client, which is the answer', () => {
  expect(socketClientIp(fakeSocketWithHeaders({ 'x-forwarded-for': '203.0.113.5' }))).toBe(
    '203.0.113.5',
  );
});

test('socketClientIp: Cloudflare-proxied hostname — the ALB appended a Cloudflare edge, so the client is the entry Cloudflare appended', () => {
  expect(
    socketClientIp(fakeSocketWithHeaders({ 'x-forwarded-for': '203.0.113.5, 172.70.1.2' })),
  ).toBe('203.0.113.5');
});

test('socketClientIp: a client-forged LEFT prefix is never believed, DNS-only or proxied', () => {
  expect(socketClientIp(fakeSocketWithHeaders({ 'x-forwarded-for': '1.2.3.4, 203.0.113.5' }))).toBe(
    '203.0.113.5',
  );
  expect(
    socketClientIp(
      fakeSocketWithHeaders({ 'x-forwarded-for': '1.2.3.4, 203.0.113.5, 172.70.1.2' }),
    ),
  ).toBe('203.0.113.5');
});

test('socketClientIp: a public socket peer means no proxy in front, so the header is ignored', () => {
  expect(
    socketClientIp(fakeSocketWithHeaders({ 'x-forwarded-for': '1.2.3.4' }, '198.51.100.7')),
  ).toBe('198.51.100.7');
});

test('socketClientIp: an array-valued header (duplicate header case) is read as one joined chain', () => {
  expect(
    socketClientIp(fakeSocketWithHeaders({ 'x-forwarded-for': ['203.0.113.5', '203.0.113.6'] })),
  ).toBe('203.0.113.6');
});

test('socketClientIp: a closed socket with no address answers "unknown"', () => {
  expect(socketClientIp({ request: { headers: {}, socket: {} } })).toBe('unknown');
  expect(socketClientIp({})).toBe('unknown');
});

test('FixedWindowLimiter: allows exactly `max` hits per key within a window, then rejects', () => {
  const limiter = new FixedWindowLimiter(60_000, 3);
  const now = 1_000_000;

  expect(limiter.consume('a', now)).toBe(true);
  expect(limiter.consume('a', now)).toBe(true);
  expect(limiter.consume('a', now)).toBe(true);
  expect(limiter.consume('a', now)).toBe(false);
});

test('FixedWindowLimiter: distinct keys have independent budgets', () => {
  const limiter = new FixedWindowLimiter(60_000, 1);
  const now = 1_000_000;

  expect(limiter.consume('a', now)).toBe(true);
  expect(limiter.consume('a', now)).toBe(false);
  expect(limiter.consume('b', now)).toBe(true);
});

test('FixedWindowLimiter: the budget resets once the window elapses', () => {
  const limiter = new FixedWindowLimiter(60_000, 1);
  const now = 1_000_000;

  expect(limiter.consume('a', now)).toBe(true);
  expect(limiter.consume('a', now)).toBe(false);
  expect(limiter.consume('a', now + 60_000)).toBe(true);
});

test('FixedWindowLimiter.sweep: drops only entries whose window has expired', () => {
  const limiter = new FixedWindowLimiter(60_000, 1);
  const now = 1_000_000;

  limiter.consume('expired', now);
  limiter.consume('fresh', now + 30_000);
  limiter.sweep(now + 60_000);

  // "expired"'s window closed by now+60_000 → sweep frees its budget.
  expect(limiter.consume('expired', now + 60_000)).toBe(true);
  // "fresh"'s window (opened at now+30_000) is still open → still spent.
  expect(limiter.consume('fresh', now + 60_000)).toBe(false);
});

test('ipConnectionThrottle: within budget calls next() with no error', () => {
  const limiter = new FixedWindowLimiter(60_000, 1);

  let err: Error | undefined = new Error('not called');
  ipConnectionThrottle(limiter)(fakeSocketWithHeaders({}, '10.0.0.5'), (e) => {
    err = e;
  });

  expect(err).toBeUndefined();
});

test('ipConnectionThrottle: over budget rejects the connection via next(error) without throwing', () => {
  const limiter = new FixedWindowLimiter(60_000, 1);
  const socket = fakeSocketWithHeaders({}, '10.0.0.6');
  const throttle = ipConnectionThrottle(limiter);

  let firstErr: Error | undefined;
  throttle(socket, (e) => {
    firstErr = e;
  });
  let secondErr: Error | undefined;
  throttle(socket, (e) => {
    secondErr = e;
  });

  expect(firstErr).toBeUndefined();
  expect(secondErr).toBeInstanceOf(Error);
});
