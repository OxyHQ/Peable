import type { RequestHandler, Response } from 'express';
import { oxy } from '../oxy';
import { sendError } from './http';

/**
 * `oxy.middleware.requireScope(scope)`, answering its refusal in Peable's error
 * envelope (ADR 0014 D1).
 *
 * Oxy's check stays the ONE authority on whether a credential holds a scope
 * (first-party authority, delegated tokens): this wrapper runs it unchanged and
 * only re-renders a refusal. Oxy answers `{error, message, code, status}`, which
 * is not the `{error: {type, code, message, request_id}}` every other non-2xx
 * of the gateway is — and the contract (`errorEnvelopeSchema`) the SDK parses
 * errors with. Mount it after `requireAuthenticated`, which has already turned
 * a missing credential into the 401.
 */
export function requireScope(scope: string): RequestHandler {
  const check = oxy.middleware.requireScope(scope);
  return (req, res, next) => {
    // The stand-in response Oxy's refusal is written to: its body is dropped
    // and the refusal answered once, in Peable's shape, on the real response.
    const refusal = {
      status: () => refusal,
      json: () => {
        sendError(
          res,
          403,
          'permission_error',
          `this credential was not granted the ${scope} scope`,
          'insufficient_scope',
        );
        return refusal;
      },
    };
    check(req, refusal as unknown as Response, next);
  };
}
