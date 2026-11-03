import type { RequestHandler, Response } from 'express';
import { oxy } from '../oxy';
import { sendError } from './http';

/**
 * `oxy.middleware.requireScope(scope)`, with its refusal spelled as every
 * other Peable error (ADR 0014 D1): 403 `permission_error` /
 * `insufficient_scope`, with a `request_id`.
 *
 * Oxy's middleware decides — which scopes a service token carries, a
 * delegation narrowing them, first-party authority — and this changes nothing
 * about that decision. It only answers Oxy's refusal body
 * (`{ error: 'INSUFFICIENT_SCOPE', message, code, status }`), which no Peable
 * client parses and the contract's error envelope refuses, as the envelope.
 * The middleware is synchronous and writes its refusal with
 * `res.status(…).json(…)`; that is the only part of `res` it is handed.
 */
export function requireScope(scope: string): RequestHandler {
  const decide = oxy.middleware.requireScope(scope);
  return (req, res, next) => {
    let refusal: string | null = null;
    const probe = {
      status: () => ({
        json: (body: { message?: unknown }) => {
          refusal =
            typeof body.message === 'string'
              ? body.message
              : `Required scope '${scope}' not granted`;
        },
      }),
    } as unknown as Response;
    let allowed = false;
    decide(req, probe, () => {
      allowed = true;
    });
    if (allowed) {
      next();
      return;
    }
    sendError(
      res,
      403,
      'permission_error',
      refusal ?? `Required scope '${scope}' not granted`,
      'insufficient_scope',
    );
  };
}
