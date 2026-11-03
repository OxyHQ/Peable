import { Router } from 'express';
import { assertLocalStripeTestEnvironment } from './stripeTestGuard';

const ORIGINS = new Set(['http://localhost:8110', 'http://127.0.0.1:8110']);
const PEERS = new Set(['127.0.0.1', '::ffff:127.0.0.1']);

/** Only the strict loopback runner imports this router. No merchant-auth bypass is added to /v1. */
export function createLocalStripeTestCheckoutRouter(options: {
  assertEnvironment?: () => void;
  create: (
    operationKey: string,
    interval: 'month' | 'year',
  ) => Promise<{ intentId: string; clientSecret: string }>;
  prepare?: () => Promise<unknown>;
  read?: (intentId: string, capability: string) => Promise<unknown>;
}) {
  const assertEnvironment =
    options.assertEnvironment ?? (() => assertLocalStripeTestEnvironment(process.env));
  assertEnvironment();
  const router = Router();
  const attempts: number[] = [];
  router.get('/__local/checkout-test/config', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      !PEERS.has(req.socket.remoteAddress ?? '') ||
      req.get('host') !== '127.0.0.1:4310' ||
      !ORIGINS.has(req.get('origin') ?? '') ||
      req.get('x-peable-local-test') !== '1' ||
      !options.prepare
    ) {
      res.status(403).json({ error: 'local_test_request_required' });
      return;
    }
    try {
      assertEnvironment();
      res.json(await options.prepare());
    } catch {
      res.status(503).json({ error: 'local_test_configuration_unavailable' });
    }
  });

  router.post('/__local/checkout-test', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      !PEERS.has(req.socket.remoteAddress ?? '') ||
      req.get('host') !== '127.0.0.1:4310' ||
      !ORIGINS.has(req.get('origin') ?? '') ||
      req.get('x-peable-local-test') !== '1' ||
      !req.is('application/json')
    ) {
      res.status(403).json({ error: 'local_test_request_required' });
      return;
    }
    const key = req.get('idempotency-key');
    if (
      !key ||
      !/^[A-Za-z0-9_-]{16,80}$/.test(key) ||
      !req.body ||
      Array.isArray(req.body) ||
      typeof req.body !== 'object' ||
      Object.keys(req.body).length !== 1 ||
      (req.body.interval !== 'month' && req.body.interval !== 'year')
    ) {
      res.status(400).json({ error: 'invalid_local_test_request' });
      return;
    }
    const now = Date.now();
    while (attempts.length && (attempts[0] ?? now) <= now - 60_000) attempts.shift();
    if (attempts.length >= 10) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'local_test_rate_limit' });
      return;
    }
    attempts.push(now);
    try {
      assertEnvironment();
      const result = await options.create(key, req.body.interval);
      res.json(result);
    } catch {
      res.status(503).json({ error: 'local_test_unavailable' });
    }
  });
  router.get('/__local/checkout-test/:intentId/subscription', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const capability = req.get('x-peable-client-secret');
    if (
      !PEERS.has(req.socket.remoteAddress ?? '') ||
      req.get('host') !== '127.0.0.1:4310' ||
      !ORIGINS.has(req.get('origin') ?? '') ||
      !capability ||
      capability.length > 256 ||
      !options.read
    ) {
      res.status(403).json({ error: 'local_test_request_required' });
      return;
    }
    try {
      assertEnvironment();
      res.json(await options.read(req.params.intentId, capability));
    } catch {
      res.status(503).json({ error: 'local_test_subscription_unavailable' });
    }
  });
  return router;
}
