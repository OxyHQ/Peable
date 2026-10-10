/**
 * Inbound provider webhooks: `/v1/webhooks/stripe` and
 * `/v1/webhooks/stripe/connect`.
 *
 * ## This router MUST be mounted BEFORE the global `express.json()`
 *
 * Stripe signs the exact BYTES it sent. `JSON.stringify(req.body)` reproduces
 * them only by luck — key order, unicode escaping and number formatting all
 * differ — so a parser reaching the stream first does not weaken verification,
 * it breaks every delivery, permanently and for every event. This is the FIRST
 * router in this application with that property: `server.ts` has mounted
 * `express.json()` globally since the first release because nothing needed raw
 * bytes.
 *
 * This router mounts its OWN `express.raw` on each path, so the bytes survive as
 * a Buffer. That parser must never be replaced by `express.json()` "for
 * consistency": it would run before the handler on every request to these paths
 * and silently make every signature fail.
 *
 * `routes/__tests__/providerWebhooks.integration.test.ts` asserts the invariant
 * against the REAL middleware chain — a valid signature verifies through
 * `createGateway()` and fails through a deliberately json-parsed copy of the
 * same router — so a later reorder fails CI rather than production.
 *
 * ## Two endpoints, because Stripe signs them with two different secrets
 *
 * ADR 0001 D2 registers a platform-scope endpoint and a Connect-scope one. They
 * are separate Stripe objects with separate signing secrets, so they cannot
 * share a path: the secret to verify against is decided by WHICH endpoint the
 * delivery arrived at, and nothing in the body can be trusted to say. Accepting
 * either secret on either path would mean a leaked platform secret could forge a
 * connected-account event.
 *
 * ## No Oxy auth, and no rate limiter
 *
 * No session, no bearer, no service token: Stripe is not an Oxy principal and
 * the signature is the entire authenticity story. The router is mounted before
 * the global `createOxyRateLimit` too, and no scoped limiter is added here —
 * deliberately. That limiter keys anonymous callers by IP, and every Stripe
 * delivery on earth arrives from a small pool of Stripe's own addresses, so a
 * per-IP bucket is one bucket for the entire provider: a legitimate burst (an
 * incident backlog being redelivered) would trip it, and Stripe would retry into
 * the same bucket until it disabled the endpoint. What bounds the work instead
 * is real: `express.raw`'s size limit caps the bytes, an unverifiable body is
 * refused before any database access, and a duplicate costs one insert that
 * converges on an index.
 */
import express, { Router, type Request, type Response } from 'express';
import { ingestProviderDelivery, type IngressResult } from '../services/providers/ingress';
import type { StripeWebhookScope } from '../services/providers/stripe/stripeProvider';

/**
 * Hard cap on a buffered delivery.
 *
 * Stripe's own limit on an event payload is well under this; the biggest real
 * ones are a `charge` with a long metadata set. This is the actual bound on what
 * an unauthenticated caller can make this endpoint allocate, which is why it is
 * here rather than relying on a rate limiter that cannot safely be applied.
 */
const RAW_BODY_LIMIT = '1mb';

/** Turn an ingress result into the HTTP answer. */
function respond(res: Response, result: IngressResult): void {
  switch (result.kind) {
    case 'accepted':
    case 'duplicate':
      // 200 means STORED. Never processed — see `services/providers/ingress.ts`.
      res.status(200).json({ received: true, duplicate: result.kind === 'duplicate' });
      return;
    case 'ignored':
      // Authentic and correctly refused. 200 so Stripe stops retrying something
      // that will never be accepted; the `ignored` field says which condition.
      res.status(200).json({ received: false, ignored: result.reason });
      return;
    case 'rejected':
      // 400 and nothing persisted. Not 401: Stripe treats any non-2xx as a
      // failed delivery and retries either way, and a 400 reads correctly in the
      // dashboard as "this endpoint refused the request" rather than implying a
      // credential Peable could have supplied.
      res.status(400).json({ received: false, error: result.reason });
      return;
  }
}

/** One endpoint's handler. Both scopes run identical code with a different secret. */
function handleDelivery(scope: StripeWebhookScope) {
  return async (req: Request, res: Response): Promise<void> => {
    const signature = req.get('Stripe-Signature');
    if (signature === undefined || signature === '') {
      res.status(400).json({ received: false, error: 'missing_signature' });
      return;
    }

    const result = await ingestProviderDelivery(
      {
        // `express.raw` leaves a Buffer; anything else means a parser got here
        // first, which the integration test exists to stop. An empty buffer then
        // fails verification, which is the safe direction.
        payload: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        signature,
        scope,
      },
      'stripe',
    );
    respond(res, result);
  };
}

/**
 * The router.
 *
 * A factory rather than a module-level singleton, to match every other router in
 * this application and so a test can mount a second copy with a different
 * parser in front of it.
 */
export function createProviderWebhooksRouter(): Router {
  const router = Router();

  /**
   * The CONNECT path is registered first.
   *
   * Express matches in registration order, and the two paths differ only by a
   * suffix. Written down because a future catch-all added above them would
   * silently swallow the connect endpoint into the platform secret — verifying
   * every connect delivery against the wrong secret and rejecting all of them,
   * which reads in the dashboard as Stripe's problem.
   */
  router.post(
    '/v1/webhooks/stripe/connect',
    express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }),
    handleDelivery('connect'),
  );

  router.post(
    '/v1/webhooks/stripe',
    express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }),
    handleDelivery('platform'),
  );

  // NO `express.json()` is mounted on this router, and none may ever be.
  return router;
}
