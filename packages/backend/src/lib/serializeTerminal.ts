import {
  TERMINAL_ACTION_FAILURE_MESSAGES,
  TERMINAL_ACTION_UNKNOWN_FAILURE,
  type TerminalLocation,
  type TerminalReader,
} from '@peable.to/shared-types';
import type { TerminalLocationRow, TerminalReaderRow } from '../db/terminal/terminalRepository';
import { toUnix } from './time';

/** `terminal.location` on the wire (ADR 0024). The provider's id never leaves. */
export function toTerminalLocationDTO(row: TerminalLocationRow): TerminalLocation {
  return {
    id: row.publicId,
    object: 'terminal.location',
    livemode: row.livemode,
    display_name: row.displayName,
    address: row.address,
    metadata: row.metadata,
  };
}

/** Orbit's sentence for a reader action's failure code — never the provider's prose. */
export function terminalFailureMessage(code: string | null): string {
  return (
    (code !== null ? TERMINAL_ACTION_FAILURE_MESSAGES[code] : undefined) ??
    TERMINAL_ACTION_UNKNOWN_FAILURE
  );
}

/** `terminal.reader` on the wire (ADR 0024). The provider's id never leaves. */
export function toTerminalReaderDTO(row: TerminalReaderRow): TerminalReader {
  const action = row.action;
  return {
    id: row.publicId,
    object: 'terminal.reader',
    livemode: row.livemode,
    label: row.label,
    device_type: row.deviceType,
    serial_number: row.serialNumber,
    status: row.status,
    last_seen_at: row.lastSeenAt === null ? null : toUnix(row.lastSeenAt),
    location: row.locationPublicId,
    action:
      action === null
        ? null
        : {
            type: action.type,
            status: action.status,
            failure_code: action.status === 'failed' ? action.failureCode : null,
            failure_message:
              action.status === 'failed' ? terminalFailureMessage(action.failureCode) : null,
            process_payment_intent: {
              payment_intent: action.paymentIntentPublicId,
              process_config: {
                enable_customer_cancellation: action.enableCustomerCancellation,
                skip_tipping: true,
              },
            },
          },
    metadata: row.metadata,
  };
}
