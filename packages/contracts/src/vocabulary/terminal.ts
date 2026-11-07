// Terminal (`tml_…`, `tmr_…`, ADR 0024) — the closed value sets its schemas
// are built from. Zod-free: `@peable.to/shared-types` re-exports them, and the
// backend's CHECK constraints are derived from the same tuples.

/** Whether the provider last saw the reader — Stripe's two. */
export const TERMINAL_READER_STATUSES = ['online', 'offline'] as const;
export type TerminalReaderStatus = (typeof TERMINAL_READER_STATUSES)[number];

/**
 * The reader actions Orbit starts and follows. Stripe's readers do more
 * (collect inputs, display a cart, refunds); Orbit drives one: collecting a
 * PaymentIntent (`process_payment_intent`).
 */
export const TERMINAL_READER_ACTION_TYPES = ['process_payment_intent'] as const;
export type TerminalReaderActionType = (typeof TERMINAL_READER_ACTION_TYPES)[number];

/** Where the reader's action stands — Stripe's three. */
export const TERMINAL_READER_ACTION_STATUSES = ['in_progress', 'succeeded', 'failed'] as const;
export type TerminalReaderActionStatus = (typeof TERMINAL_READER_ACTION_STATUSES)[number];

/**
 * The card-present payment method types: a PaymentIntent that carries one is
 * collected by a reader and nothing else — never offered in a checkout, never
 * confirmed with a saved card. Interac is not offered.
 */
export const TERMINAL_PAYMENT_METHOD_TYPES = ['card_present'] as const;
export type TerminalPaymentMethodType = (typeof TERMINAL_PAYMENT_METHOD_TYPES)[number];

/**
 * A registration code the provider answers with a SIMULATED reader
 * (`simulated-wpe`, `simulated-s700`, …). Test mode only: a live reader is a
 * device someone holds.
 */
export const SIMULATED_READER_REGISTRATION_PREFIX = 'simulated-';

/** Field bounds. */
export const TERMINAL_LIMITS = {
  displayNameMax: 100,
  labelMax: 100,
  registrationCodeMax: 100,
} as const;

/**
 * Orbit's own sentence for a reader action's failure code — the provider's
 * prose never reaches the wire (ADR 0019's rule for `last_payment_error`). A
 * code not listed reads {@link TERMINAL_ACTION_UNKNOWN_FAILURE}.
 */
export const TERMINAL_ACTION_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  card_declined: 'The card was declined.',
  customer_canceled: 'The cardholder canceled on the reader.',
  intent_invalid_state: 'The PaymentIntent could no longer be collected.',
  reader_busy: 'The reader was busy.',
  reader_offline: 'The reader was offline.',
  reader_timeout: 'The reader did not answer in time.',
  request_canceled: 'The collection was canceled.',
  terminal_reader_timeout: 'The reader did not answer in time.',
};
export const TERMINAL_ACTION_UNKNOWN_FAILURE = 'The reader could not complete the payment.';
