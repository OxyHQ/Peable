/**
 * The HTTP answers of Orbit's money model (ADR 0015), in one place so every
 * route — service-authed and dashboard — answers a refusal identically.
 */
import type { Response } from 'express';
import {
  AccountMissingError,
  AccountImmutableFieldError,
} from '../services/accounts/merchantAccount';
import { ChargeRoutingError, ThirdPartyLiveGateError } from '../services/money/chargeRouting';
import { LedgerUnavailableError } from '../services/money/ledger';
import { PayoutNotCancelableError, PayoutNotManualError } from '../services/money/payouts';
import { AccountsUnavailableError } from '../services/accounts/connectedAccountService';
import { ProviderError } from '../services/providers/provider';
import { FaircoinAccountRequiredError } from '../services/faircoinAccount';
import { sendError, sendProviderError } from './http';

/** Answer a money refusal and return `true`, or return `false` for anything else. */
export function sendMoneyRefusal(res: Response, error: unknown): boolean {
  // A live merchant without its FairCoin key takes no payment (ADR 0021 D5).
  if (error instanceof FaircoinAccountRequiredError) {
    sendError(res, error.status, 'invalid_request_error', error.message, error.code);
    return true;
  }
  if (error instanceof ThirdPartyLiveGateError) {
    sendError(res, 403, 'permission_error', error.message, 'live_payments_gated');
    return true;
  }
  if (error instanceof ChargeRoutingError) {
    sendError(res, error.status, 'invalid_request_error', error.message, error.code, error.param);
    return true;
  }
  if (error instanceof AccountMissingError) {
    sendError(res, 404, 'invalid_request_error', error.message, 'account_missing');
    return true;
  }
  if (error instanceof AccountImmutableFieldError) {
    sendError(res, 400, 'invalid_request_error', error.message, 'parameter_invalid', error.param);
    return true;
  }
  if (error instanceof PayoutNotManualError || error instanceof PayoutNotCancelableError) {
    sendError(res, 400, 'invalid_request_error', error.message, 'payout_not_allowed');
    return true;
  }
  if (error instanceof LedgerUnavailableError || error instanceof AccountsUnavailableError) {
    sendError(res, 503, 'api_error', error.message);
    return true;
  }
  if (error instanceof ProviderError) {
    sendProviderError(res, error);
    return true;
  }
  return false;
}
