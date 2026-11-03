import type { RequestHandler, Response } from 'express';
import { oxy } from '../oxy';
import { sendError } from './http';

/**
 * `oxy.middleware.requireScope`, with its refusal answered in the gateway's
 * error envelope (ADR 0014 D1). The Oxy middleware decides — first-party
 * authority, delegated scopes, the scope itself — and answers its OWN body
 * (`{ error: 'INSUFFICIENT_SCOPE', code, status, message }`), which is not
 * Peable's wire: a caller branching on `error.type` would read nothing.
 */
export function requireScope(scope: string): RequestHandler {
  const check = oxy.middleware.requireScope(scope);
  return (req, res, next) => {
    let status = 403;
    const refusal = Object.create(res) as Response;
    refusal.status = (code: number) => {
      status = code;
      return refusal;
    };
    refusal.json = (body?: unknown) => {
      const message =
        typeof (body as { message?: unknown } | undefined)?.message === 'string'
          ? (body as { message: string }).message
          : `Required scope '${scope}' not granted`;
      sendError(res, status, 'permission_error', message, 'scope_missing');
      return res;
    };
    check(req, refusal, next);
  };
}
