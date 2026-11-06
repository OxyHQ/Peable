import type { Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { sendError } from './http';

/**
 * The per-PAYER bound on fresh FairCoin addresses from the anonymous payer
 * routes (ADR 0021 D9, amended 2026-11-06): a hosted checkout's FairCoin
 * confirm and a hosted invoice's FairCoin pay, keyed by the client address
 * (`req.ip`, which `oxyTrustProxy` makes the real client behind Cloudflare and
 * the ALB). Each such request may reserve a fresh address in the recipient's
 * wallet, whose watch set every address joins for ever; the recipient's own
 * daily bound (`services/faircoin/addressPool.ts`) is what no number of
 * payers can pass, and this keeps one payer from spending it alone.
 *
 * In front of the general public limiter (30 requests per 15 minutes per
 * client), counted only for FairCoin. In memory, so per task.
 */
export const FAIRCOIN_PAYER_WINDOW_MS = 60 * 60 * 1000;
export const FAIRCOIN_PAYER_MAX = 20;

export function createFaircoinPayerLimit(): RequestHandler {
  return rateLimit({
    windowMs: FAIRCOIN_PAYER_WINDOW_MS,
    limit: FAIRCOIN_PAYER_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      sendError(
        res,
        429,
        'rate_limit_error',
        'too many FairCoin payments requested from this connection — try again later, or pay another way',
      );
    },
  });
}

/**
 * Run a limiter by hand, inside a handler that has already decided the request
 * counts; `true` when it let the request through (else it answered 429).
 */
export async function passesLimit(
  limiter: RequestHandler,
  req: Request,
  res: Response,
): Promise<boolean> {
  let through = false;
  await limiter(req, res, () => {
    through = true;
  });
  return through;
}
