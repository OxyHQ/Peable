/**
 * The SELLER-facing half of FairCoin connected accounts:
 * `/v1/connect/onboarding/:token` (ADR 0012 D3).
 *
 * Authenticated as an Oxy USER — the seller's own session — and never as a
 * service. That is the decision this file exists to keep: the watch-only key
 * that decides who receives a seller's money is accepted only from the seller,
 * so a platform (whose credential is a service token) cannot reach these routes
 * at all, and the link token alone is not enough without the session it names.
 *
 * The page that calls these is the Peable wallet (`app/connect/[token].tsx`),
 * which already holds both the key and the seller's Oxy session.
 *
 * Request schemas: the contract's (`@peable.to/contracts`
 * `connectOnboardingRoutes`).
 */
import { Router } from 'express';
import type { RequestHandler, Response } from 'express';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { type ConnectOnboardingComplete, registerFaircoinKeyParams } from '@peable.to/contracts';
import { type ErrorCode, errorDocUrl } from '@peable.to/contracts/vocabulary';
import {
  describeOnboarding,
  OnboardingRefusedError,
  registerFromOnboarding,
} from '../services/accounts/faircoinOnboarding';
import { WatchOnlyViolationError } from '../services/watchOnly';
import { requestIdOf } from '../lib/requestId';
import { sendError, sendValidationError, wrap } from '../lib/http';

/** 32 random bytes in base64url are 43 characters. A guard, not a format. */
const TOKEN_MAX_LENGTH = 128;

function sendRefusal(res: Response, error: OnboardingRefusedError): void {
  // Every refusal code is a documented one: this does not compile otherwise.
  const code: ErrorCode = error.code;
  res.status(error.status).json({
    error: {
      type: 'invalid_request_error',
      code,
      message: error.message,
      doc_url: errorDocUrl(code),
      // Only on an expired link: where the seller goes to get a fresh one.
      ...(error.refreshUrl ? { refresh_url: error.refreshUrl } : {}),
      request_id: requestIdOf(res) ?? null,
    },
  });
}

function readToken(token: string | undefined, res: Response): string | null {
  if (!token || token.length > TOKEN_MAX_LENGTH) {
    sendError(
      res,
      404,
      'invalid_request_error',
      'this onboarding link does not exist',
      'link_not_found',
    );
    return null;
  }
  return token;
}

/**
 * `requireOxyUser` is handed in (`server.ts` passes the process's one, from
 * `lib/http.ts`) so tests can stand in for a real Oxy bearer with a stub that sets
 * the user; production uses the seller's own session, exactly as the social
 * routes do for a payer.
 */
export function createConnectRouter(deps: { requireOxyUser: RequestHandler }): Router {
  const { requireOxyUser } = deps;
  const router = Router();

  /** What the seller is being asked to do. Looking consumes nothing. */
  router.get(
    '/v1/connect/onboarding/:token',
    requireOxyUser,
    wrap(async (req, res) => {
      const token = readToken(req.params.token, res);
      if (!token) return;
      try {
        res
          .status(200)
          .json(await describeOnboarding({ token, oxyUserId: getRequiredOxyUserId(req) }));
      } catch (error) {
        if (error instanceof OnboardingRefusedError) {
          sendRefusal(res, error);
          return;
        }
        throw error;
      }
    }),
  );

  /**
   * Register the seller's watch-only key — the ONLY way a key reaches a
   * connected account. Runs the non-custody firewall, consumes the link, and
   * tells the platform, all in one transaction.
   */
  router.post(
    '/v1/connect/onboarding/:token/faircoin',
    requireOxyUser,
    wrap(async (req, res) => {
      const token = readToken(req.params.token, res);
      if (!token) return;
      const parsed = registerFaircoinKeyParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      try {
        const { account, returnUrl } = await registerFromOnboarding({
          token,
          oxyUserId: getRequiredOxyUserId(req),
          xpub: parsed.data.xpub,
        });
        const body: ConnectOnboardingComplete = {
          object: 'connect_onboarding',
          account_id: account.publicId,
          status: 'active',
          return_url: returnUrl,
        };
        res.status(200).json(body);
      } catch (error) {
        if (error instanceof OnboardingRefusedError) {
          sendRefusal(res, error);
          return;
        }
        // A key that can spend, or one for the other chain. Refused and never
        // stored — the message says which.
        if (error instanceof WatchOnlyViolationError) {
          sendError(res, 400, 'invalid_request_error', error.message, 'watch_only_violation');
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
