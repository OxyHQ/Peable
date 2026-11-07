// Terminal (`tml_…`, `tmr_…`, ADR 0024). The wire types are the contract's
// (`@peable.to/contracts`), re-exported here as types; the closed value sets
// come from the zod-free `@peable.to/contracts/vocabulary`.

export {
  SIMULATED_READER_REGISTRATION_PREFIX,
  TERMINAL_ACTION_FAILURE_MESSAGES,
  TERMINAL_ACTION_UNKNOWN_FAILURE,
  TERMINAL_LIMITS,
  TERMINAL_PAYMENT_METHOD_TYPES,
  TERMINAL_READER_ACTION_STATUSES,
  TERMINAL_READER_ACTION_TYPES,
  TERMINAL_READER_STATUSES,
  type TerminalPaymentMethodType,
  type TerminalReaderActionStatus,
  type TerminalReaderActionType,
  type TerminalReaderStatus,
} from '@peable.to/contracts/vocabulary';

export type {
  CreateTerminalConnectionTokenParams,
  CreateTerminalLocationParams,
  CreateTerminalReaderParams,
  ListTerminalLocationsParams,
  ListTerminalReadersParams,
  PresentPaymentMethodParams,
  ProcessPaymentIntentParams,
  RetrieveTerminalReaderParams,
  TerminalConnectionToken,
  TerminalLocation,
  TerminalReader,
  TerminalReaderActionParams,
  UpdateTerminalLocationParams,
  UpdateTerminalReaderParams,
} from '@peable.to/contracts';
