import type { Response } from 'express';
import type { ErrorCode } from '@peable.to/contracts/vocabulary';
import { sendError } from '../../lib/http';
import { FaircoinAccountRequiredError } from '../faircoinAccount';

/**
 * A checkout refusal naming the field at fault (ADR 0014 D1). Every refusal a
 * payer can act on carries the `param` the hosted checkout shows it beside.
 */
export class CheckoutError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
    readonly code: ErrorCode,
    message: string,
    readonly param?: string,
    readonly type: 'invalid_request_error' | 'api_error' = status >= 500
      ? 'api_error'
      : 'invalid_request_error',
  ) {
    super(message);
    this.name = 'CheckoutError';
  }
}

export const invalid = (code: ErrorCode, message: string, param?: string) =>
  new CheckoutError(400, code, message, param);

/**
 * The ADR 0014 answer for a {@link CheckoutError} or the live merchant's
 * missing FairCoin key ({@link FaircoinAccountRequiredError}, ADR 0021 D5);
 * anything else is rethrown.
 */
export function sendCheckoutError(res: Response, error: unknown): void {
  if (error instanceof FaircoinAccountRequiredError) {
    sendError(res, error.status, 'invalid_request_error', error.message, error.code);
    return;
  }
  if (!(error instanceof CheckoutError)) throw error;
  sendError(res, error.status, error.type, error.message, error.code, error.param);
}
