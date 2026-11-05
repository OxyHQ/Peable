/**
 * The billing engine's refusals (ADR 0018), answered as the ADR 0014 error
 * envelope by the route runner. A refusal names the request field at fault
 * whenever there is one.
 */
export type BillingEngineErrorCode =
  | 'parameter_invalid'
  | 'parameter_missing'
  | 'resource_missing'
  | 'resource_already_exists'
  | 'invoice_not_editable'
  | 'invoice_unexpected_state'
  | 'invoice_no_customer_line_items'
  | 'invoice_payment_intent_requires_action'
  | 'subscription_unexpected_state'
  | 'customer_currency_mismatch'
  | 'customer_test_clock_mismatch'
  | 'coupon_invalid'
  | 'promotion_code_invalid'
  | 'payment_method_missing'
  | 'faircoin_cannot_debit'
  | 'faircoin_price_unavailable'
  | 'faircoin_account_required'
  | 'credit_note_exceeds_invoice'
  | 'test_mode_only'
  | 'test_clock_unexpected_state'
  | 'tax_calculation_unavailable'
  | 'customer_location_insufficient'
  | 'tax_settings_not_active'
  | 'meter_event_customer_missing'
  | 'feature_lookup_key_taken'
  | 'portal_feature_disabled'
  | 'portal_session_expired'
  | 'card_declined'
  | 'rail_unavailable'
  | 'faircoin_account_required';

export type BillingEngineStatus = 400 | 402 | 403 | 404 | 409 | 503;

export class BillingEngineError extends Error {
  constructor(
    readonly code: BillingEngineErrorCode,
    message: string,
    readonly param?: string,
    readonly status: BillingEngineStatus = 400,
    /** `card_error` for a 402; `invalid_request_error` otherwise; `api_error` for a 503. */
    readonly type:
      | 'invalid_request_error'
      | 'card_error'
      | 'api_error'
      | 'permission_error' = status === 402
      ? 'card_error'
      : status === 503
        ? 'api_error'
        : status === 403
          ? 'permission_error'
          : 'invalid_request_error',
    /** Extra fields of the error object (`invoice`, `payment_intent`). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BillingEngineError';
  }
}

export function missing(what: string, param?: string): BillingEngineError {
  return new BillingEngineError(
    'resource_missing',
    param ? `no such ${what}` : `${what} not found`,
    param,
    param ? 400 : 404,
  );
}

export function invalid(message: string, param?: string): BillingEngineError {
  return new BillingEngineError('parameter_invalid', message, param);
}
