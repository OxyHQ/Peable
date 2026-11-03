import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ErrorCode } from '@peable.to/contracts/vocabulary';
import { sendError, sendValidationError } from '../lib/http';
import { assertLocalStripeTestEnvironment } from './stripeTestGuard';

const ORIGINS = new Set(['http://localhost:8110', 'http://127.0.0.1:8110']);
const PEERS = new Set(['127.0.0.1', '::ffff:127.0.0.1']);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,80}$/;

/** The only body the create route takes: the cadence. Amount, price and customer are the server's. */
const createBodySchema = z.object({ interval: z.enum(['month', 'year']) }).strict();

/** Every refusal of the loopback boundary is one answer, so none says which check failed. */
function refuseOutsideBoundary(res: Response): void {
  sendError(
    res,
    403,
    'permission_error',
    'this route answers only the local test checkout on loopback',
    'local_test_request_required',
  );
}

/** A failure behind the boundary, without echoing what failed (provider payloads stay out). */
function unavailable(res: Response, code: ErrorCode, message: string): void {
  sendError(res, 503, 'api_error', message, code);
}

/** The loopback peer, the exact Host and one of the two local origins. */
function fromLocalOrigin(req: Request): boolean {
  return (
    PEERS.has(req.socket.remoteAddress ?? '') &&
    req.get('host') === '127.0.0.1:4310' &&
    ORIGINS.has(req.get('origin') ?? '')
  );
}

/** Only the strict loopback runner imports this router. No merchant-auth bypass is added to /v1. */
export function createLocalStripeTestCheckoutRouter(options: {
  assertEnvironment?: () => void;
  create: (
    operationKey: string,
    interval: 'month' | 'year',
  ) => Promise<{ payment_intent: string; client_secret: string }>;
  prepare?: () => Promise<unknown>;
  read?: (paymentIntent: string, capability: string) => Promise<unknown>;
}) {
  const assertEnvironment =
    options.assertEnvironment ?? (() => assertLocalStripeTestEnvironment(process.env));
  assertEnvironment();
  const router = Router();
  const attempts: number[] = [];
  router.get('/__local/checkout-test/config', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!fromLocalOrigin(req) || req.get('x-peable-local-test') !== '1' || !options.prepare) {
      refuseOutsideBoundary(res);
      return;
    }
    try {
      assertEnvironment();
      res.status(200).json(await options.prepare());
    } catch {
      unavailable(
        res,
        'local_test_configuration_unavailable',
        'the local checkout configuration is unavailable; restart the local runner',
      );
    }
  });

  router.post('/__local/checkout-test', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      !fromLocalOrigin(req) ||
      req.get('x-peable-local-test') !== '1' ||
      !req.is('application/json')
    ) {
      refuseOutsideBoundary(res);
      return;
    }
    const key = req.get('idempotency-key');
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      sendError(
        res,
        400,
        'invalid_request_error',
        'Idempotency-Key is required: 16 to 80 characters of A-Z, a-z, 0-9, _ or -',
        'parameter_invalid',
        'Idempotency-Key',
      );
      return;
    }
    const body = createBodySchema.safeParse(req.body);
    if (!body.success) {
      sendValidationError(res, body.error);
      return;
    }
    const now = Date.now();
    while (attempts.length && (attempts[0] ?? now) <= now - 60_000) attempts.shift();
    if (attempts.length >= 10) {
      res.setHeader('Retry-After', '60');
      sendError(
        res,
        429,
        'rate_limit_error',
        'at most ten local test checkouts a minute',
        'rate_limited',
      );
      return;
    }
    attempts.push(now);
    try {
      assertEnvironment();
      res.status(200).json(await options.create(key, body.data.interval));
    } catch {
      unavailable(res, 'local_test_unavailable', 'the local test checkout could not be created');
    }
  });

  router.get('/__local/checkout-test/:paymentIntent/subscription', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const capability = req.get('x-peable-client-secret');
    const { paymentIntent } = req.params;
    if (
      !fromLocalOrigin(req) ||
      !capability ||
      capability.length > 256 ||
      !paymentIntent ||
      !options.read
    ) {
      refuseOutsideBoundary(res);
      return;
    }
    try {
      assertEnvironment();
      res.status(200).json(await options.read(paymentIntent, capability));
    } catch {
      unavailable(
        res,
        'local_test_subscription_unavailable',
        'the local test subscription could not be read',
      );
    }
  });
  return router;
}
