// The error vocabulary (ADR 0014 D1). Zod-free: the documentation site renders
// its errors page from these two tables, and the backend's `sendError` takes an
// `ErrorCode`, so a code the gateway can answer with and the page does not list
// is a compile error rather than a dead `doc_url`.

/** `error.type`: the broad class a caller branches on first. */
export const ERROR_TYPES = [
  'api_error',
  'authentication_error',
  'card_error',
  'idempotency_error',
  'invalid_request_error',
  'permission_error',
  'rate_limit_error',
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

/** What each `error.type` means, and the HTTP status it comes with. */
export const ERROR_TYPE_DESCRIPTIONS: Readonly<Record<ErrorType, string>> = {
  api_error:
    'Something went wrong on Peable or its provider (5xx, or 502 for a retryable provider fault). Safe to retry with the same `Idempotency-Key`.',
  authentication_error: 'The credential is missing, expired or invalid (401).',
  card_error:
    'The payment method was declined (402). `decline_code` carries the issuer reason when there is one.',
  idempotency_error:
    'The `Idempotency-Key` was reused with a different request (400), or the first request with it is still running (409).',
  invalid_request_error:
    'The request is malformed, names something that does not exist, or conflicts with the state of an object (400, 404, 409).',
  permission_error: 'The credential is valid but may not do this (403).',
  rate_limit_error: 'Too many requests (429). Back off and retry.',
};

/** Where every code is documented. */
export const ERROR_DOCS_BASE_URL = 'https://docs.peable.to/errors';

/** The `doc_url` of a code. */
export function errorDocUrl(code: string): string {
  return `${ERROR_DOCS_BASE_URL}#${code}`;
}

/**
 * Every `error.code` the gateway answers with, and what it means. The keys ARE
 * the list — {@link ERROR_CODES} is derived from them — so a new code cannot be
 * added without its description.
 */
export const ERROR_CODE_DESCRIPTIONS = {
  account_invalid: 'The `Peable-Account` header names no connected account of this platform.',
  account_missing: 'The merchant has no account object yet.',
  amount_not_representable: 'The amount does not fit the currency or the rail.',
  billing_not_enabled: 'Billing is not enabled for this merchant.',
  billing_provider_unavailable: 'The billing provider could not be reached; retry.',
  domain_taken: 'The domain is already registered by another merchant.',
  file_too_large: 'The uploaded file is larger than its purpose allows.',
  file_unavailable: 'The file exists but its contents cannot be served right now.',
  idempotency_error:
    'The `Idempotency-Key` was used with a different request, or its first request is still running.',
  idempotency_key_invalid: 'The `Idempotency-Key` header is not a valid key.',
  invalid_billing_request: 'The billing request is not valid for this subscription or offer.',
  keyless_recipient: 'The recipient has no receive key, so no address can be derived for them.',
  link_not_found: 'The link does not exist or is no longer active.',
  live_payments_gated: 'Live payments are not enabled for this application yet.',
  local_test_request_required: 'This test helper only answers a local test request.',
  parameter_invalid: 'A parameter is invalid; `param` names it.',
  parameter_missing: 'A required parameter is missing; `param` names it.',
  parameter_unknown:
    'The request carries a parameter this route does not accept; `param` names it.',
  payment_intent_unexpected_state:
    'The PaymentIntent is in a status that does not allow this operation.',
  payout_not_allowed: 'Payouts cannot be created for this account.',
  rate_limited: 'Too many requests; back off and retry.',
  refund_not_cancelable: 'The refund has already left a cancelable state.',
  resource_conflict: 'The object changed under this request; read it again and retry.',
  resource_missing: 'The object does not exist, or this credential cannot read it.',
  setup_intent_unexpected_state:
    'The SetupIntent is in a status that does not allow this operation.',
  tax_not_enabled: 'Peable Tax is not enabled for this merchant.',
  test_mode_only: 'This operation exists in test mode only.',
  too_many_streams: 'Too many live streams are open for this merchant.',
  url_invalid: 'The URL is not an allowed https URL.',
  watch_only_violation:
    'The extended key carries a private key. Peable only ever accepts watch-only (public) keys.',
  webhook_endpoint_disabled: 'The webhook endpoint is disabled.',
  webhook_endpoint_limit_reached:
    'The merchant already has the maximum number of webhook endpoints.',
  account_not_ready:
    'The connected account cannot take this payment yet: its onboarding or a capability is incomplete.',
  approval_incomplete: 'The tax registration has not been approved by the account owner yet.',
  approval_requires_provider:
    'The tax registration needs the provider to confirm it before it can be approved.',
  checkout_session_expired: 'The Checkout Session has expired.',
  checkout_session_not_open: 'The Checkout Session is no longer open (complete or expired).',
  customer_location_conflicting:
    "The customer's location evidence disagrees, so the sale cannot be placed in one jurisdiction.",
  customer_location_expired: "The customer's location evidence is too old to price a sale with.",
  customer_location_insufficient:
    "There is not enough evidence of the customer's location to decide whether the sale is taxed.",
  customer_location_invalid: "The customer's location evidence is malformed.",
  dispute_already_submitted:
    'Evidence for this dispute has already been submitted; it is one shot.',
  dispute_not_answerable: 'The dispute is in a status that no longer accepts evidence.',
  idempotency_conflict: 'The same operation key was used for a different billing request.',
  identity_conflict: 'The billing identity already belongs to another customer or subscription.',
  in_progress: 'The same operation is still running; retry with the same key.',
  invalid_provider_response:
    'The provider answered with something Peable cannot trust; the operation was not applied.',
  invalid_registration: 'The tax registration is not valid.',
  invalid_registration_declaration: 'The tax registration declaration is not valid.',
  invalid_tax_code: 'The tax code does not exist.',
  invalid_tax_document: 'The tax document is not valid for its declared purpose.',
  invalid_tax_request: 'The tax request is not valid.',
  lookup_key_taken: 'Another price already uses this `lookup_key`.',
  mode_unavailable: 'This Checkout mode is not available to this merchant.',
  not_found: 'The object does not exist, or this credential cannot read it.',
  payment_link_inactive: 'The Payment Link is deactivated.',
  price_is_default: "The price is its product's `default_price` and cannot be archived.",
  product_has_prices: 'The product still has prices; archive it instead.',
  product_in_use: 'The product is referenced by a subscription or a link.',
  promotion_code_invalid: 'The promotion code does not exist, is inactive or does not apply.',
  promotion_code_taken: 'Another active promotion code already uses this `code`.',
  provider_unavailable: 'The payment provider could not be reached; retry.',
  rail_unavailable: 'The payment rail this request needs is not available.',
  reconciliation_required:
    'The billing operation has an unknown outcome at the provider and is being reconciled.',
  registration_immutable: 'An approved tax registration cannot be changed.',
  resource_already_exists: 'An object with this identity already exists.',
  result_expired: 'The stored result of this operation has expired.',
  review_item_not_open: 'The review item is already resolved.',
  rule_set_version_unavailable: 'The tax rule set version is not available.',
  subscription_line_invalid: 'A subscription line item is not valid for Checkout.',
  tax_behavior_locked: "The price's `tax_behavior` cannot change once set.",
  tax_calculation_unavailable: 'Tax could not be calculated; a covered sale fails closed.',
  tax_provider_registration_mismatch:
    "The provider's registrations disagree with the ones Peable has approved.",
  tax_settings_not_active: 'Tax settings are not active for this merchant.',
  local_test_unavailable: 'The local test checkout is not available.',
  local_test_configuration_unavailable: 'The local test checkout has no provider configuration.',
  local_test_subscription_unavailable: 'The local test subscription cannot be read.',
  rail_mismatch: 'The operation does not apply to the rail this payment uses.',
  checkout_session_changed:
    'The Checkout Session changed while this request ran (a price, a discount, its tax); read it again and retry.',
  checkout_session_locked: 'The Checkout Session is being confirmed and cannot change.',
  tax_calculation_failed: 'The tax for this Checkout Session could not be calculated.',
  payment_cancellation_failed:
    'The payment could not be cancelled at the provider; the Checkout Session stays as it was.',
  invoice_not_editable: 'The invoice is finalized and can no longer be edited.',
  invoice_unexpected_state: 'The invoice is in a status that does not allow this operation.',
  invoice_no_customer_line_items: 'The invoice has no line items to finalize.',
  invoice_payment_intent_requires_action:
    "The invoice's payment needs the customer to act (a card challenge).",
  subscription_unexpected_state:
    'The subscription is in a status that does not allow this operation.',
  customer_currency_mismatch: "The currency differs from the customer's billing currency.",
  customer_test_clock_mismatch: 'The objects live on different test clocks.',
  coupon_invalid: 'The coupon does not exist or is no longer valid.',
  coupon_currency_mismatch: "The coupon's currency differs from the purchase's.",
  coupon_not_applicable: 'The coupon does not apply to these products.',
  promotion_code_inactive: 'The promotion code is inactive.',
  promotion_code_customer_mismatch: 'The promotion code is restricted to another customer.',
  promotion_code_expired: 'The promotion code has expired.',
  promotion_code_max_redemptions:
    'The promotion code has been redeemed its maximum number of times.',
  promotion_code_minimum_amount: 'The purchase is below the promotion code minimum amount.',
  payment_method_missing: 'No payment method is available to charge.',
  faircoin_cannot_debit:
    'A FairCoin invoice cannot be charged automatically: the payer signs every payment.',
  credit_note_exceeds_invoice:
    "The credit note's amount exceeds what the invoice can still credit.",
  test_clock_unexpected_state: 'The test clock is advancing; wait until it is ready.',
  meter_event_customer_missing: 'The meter event names no customer of this merchant.',
  feature_lookup_key_taken: 'Another feature already uses this `lookup_key`.',
  portal_feature_disabled: 'The customer portal configuration does not allow this action.',
  portal_session_expired: 'The customer portal session has expired.',
  card_declined: 'The card was declined.',
  promotion_code_first_time_only: "The promotion code is for a customer's first purchase only.",
  network_mismatch: 'The FairCoin network differs from the one this object uses.',
  scope_missing:
    'The credential does not carry the Oxy scope this route requires; `message` names it.',
} as const satisfies Record<string, string>;

export type ErrorCode = keyof typeof ERROR_CODE_DESCRIPTIONS;

/** Every error code, sorted. */
export const ERROR_CODES = Object.keys(ERROR_CODE_DESCRIPTIONS).sort() as [
  ErrorCode,
  ...ErrorCode[],
];

/** Whether a string is a documented error code. */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_CODE_DESCRIPTIONS, value);
}
