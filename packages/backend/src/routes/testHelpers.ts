import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { expireCheckoutSessionTestHelperParams } from '@peable.to/contracts';
import { SIMULATED_FAIRCOIN_OUTCOMES } from '@peable.to/shared-types';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findIntentById, findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import { findSessionById, findSessionForMerchant } from '../db/payments/checkoutSessionRepository';
import { idempotent } from '../lib/idempotency';
import { refuseLivemode } from '../lib/liveStream';
import { requireAuthenticated, sendError, sendValidationError, wrap } from '../lib/http';
import { toPaymentIntentDTO } from '../lib/serialize';
import { toCheckoutSessionDTO } from '../lib/serializeCheckout';
import { expireSessionNow } from '../services/checkout/sessionService';
import { expireIntentNow } from '../services/expirySweeper';
import { simulateFaircoinPayment } from '../services/testHelpers';
import { resolveMerchant } from './paymentIntents';

/**
 * `/v1/test_helpers/*` — move a TEST-MODE object the way the outside world
 * would, through the real state machine (`services/testHelpers.ts` has the
 * rule). A live credential is refused with 403 `test_mode_only` before
 * anything is read.
 *
 * Every helper is a merchant `POST` behind the generic idempotency layer, so a
 * retried simulation answers what the first one did instead of failing on a
 * payment that already moved.
 */

const simulateBodySchema = z
  .object({ outcome: z.enum(SIMULATED_FAIRCOIN_OUTCOMES).optional() })
  .strict();

function idOf(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

/** `POST /v1/test_helpers/payment_intents/:id/simulate_faircoin_payment` */
async function simulateFaircoinPaymentRoute(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const id = idOf(req, res);
  if (!id) return;
  const parsed = simulateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const intent = await findIntentForMerchant(getDb(), id, merchant.id);
  if (!intent) {
    sendError(res, 404, 'invalid_request_error', 'payment intent not found', 'resource_missing');
    return;
  }
  const result = await simulateFaircoinPayment(intent, parsed.data.outcome ?? 'settled');
  if (result.kind === 'refused') {
    sendError(res, result.status, 'invalid_request_error', result.message, result.code);
    return;
  }
  res.status(200).json(toPaymentIntentDTO(result.row));
}

/** `POST /v1/test_helpers/checkout_sessions/:id/expire` */
async function expireCheckoutSessionRoute(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const id = idOf(req, res);
  if (!id) return;
  const parsed = expireCheckoutSessionTestHelperParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const db = getDb();
  const session = await findSessionForMerchant(db, id, merchant.id);
  if (!session) {
    sendError(res, 404, 'invalid_request_error', 'checkout session not found', 'resource_missing');
    return;
  }
  // A session nobody confirmed has no payment: its deadline is its own.
  if (session.paymentIntentId === null) {
    const expired = await expireSessionNow(session);
    if (!expired) {
      sendError(res, 409, 'invalid_request_error', `this checkout session is ${session.status}`);
      return;
    }
    res.status(200).json(toCheckoutSessionDTO(expired));
    return;
  }
  const intent = await findIntentById(db, session.paymentIntentId);
  if (!intent) {
    sendError(res, 404, 'invalid_request_error', 'checkout session not found', 'resource_missing');
    return;
  }
  // The session expires WITH its payment, in that transition (`completion.ts`).
  const result = await expireIntentNow(intent);
  switch (result.kind) {
    case 'expired':
      res
        .status(200)
        .json(toCheckoutSessionDTO((await findSessionById(db, session.id)) ?? session));
      return;
    case 'not_expirable':
      sendError(
        res,
        409,
        'invalid_request_error',
        `this checkout session's payment can no longer expire: ${result.message}`,
      );
      return;
    case 'succeeded':
      sendError(
        res,
        409,
        'invalid_request_error',
        'the payment completed before the checkout session could be expired',
      );
      return;
    case 'stale':
      sendError(
        res,
        409,
        'invalid_request_error',
        "the checkout session's payment moved while this request was in flight",
      );
      return;
    case 'pending':
      sendError(
        res,
        503,
        'api_error',
        'the provider could not confirm the cancellation; retry the request',
      );
      return;
  }
}

/** The service-authed `/v1/test_helpers` router. */
export function createTestHelpersRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const write = [
    deps.requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
  ];
  const testMode = (
    handler: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
  ) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      if (refuseLivemode(res, merchant, 'Test helpers')) return;
      await handler(req, res, merchant);
    });

  router.post(
    '/v1/test_helpers/payment_intents/:id/simulate_faircoin_payment',
    ...write,
    testMode(simulateFaircoinPaymentRoute),
  );
  router.post(
    '/v1/test_helpers/checkout_sessions/:id/expire',
    ...write,
    testMode(expireCheckoutSessionRoute),
  );
  return router;
}
