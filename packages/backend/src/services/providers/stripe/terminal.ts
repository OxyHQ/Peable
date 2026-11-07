/**
 * Stripe Terminal in the gateway's vocabulary (ADR 0024).
 *
 * Pure mappings over Stripe's `terminal.location` and `terminal.reader`.
 * What leaves this module: ids, the device's type, serial, label and status,
 * the location's name and address, and a reader action as CODES — which
 * PaymentIntent it collects, its status and its failure code. Stripe's
 * `failure_message` (prose) and `ip_address` never leave.
 */
import type Stripe from 'stripe';
import type { Address, TerminalReaderActionStatus } from '@peable.to/shared-types';
import type {
  ProviderTerminalLocation,
  ProviderTerminalReader,
  ProviderTerminalReaderAction,
} from '../provider';
import { fromUnix } from '../../../lib/time';

/** The address Stripe holds, in the wire shape (every field present, `null` when not given). */
export function toAddress(address: Stripe.Address | null | undefined): Address {
  return {
    line1: address?.line1 || null,
    line2: address?.line2 || null,
    city: address?.city || null,
    state: address?.state || null,
    postal_code: address?.postal_code || null,
    country: address?.country || null,
  };
}

/** The wire address as Stripe's location params (blank fields left out). */
export function toStripeAddress(address: Address): Stripe.Terminal.LocationCreateParams.Address {
  return {
    country: address.country ?? '',
    ...(address.line1 ? { line1: address.line1 } : {}),
    ...(address.line2 ? { line2: address.line2 } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.state ? { state: address.state } : {}),
    ...(address.postal_code ? { postal_code: address.postal_code } : {}),
  };
}

export function toTerminalLocation(location: Stripe.Terminal.Location): ProviderTerminalLocation {
  return {
    providerObjectId: location.id,
    displayName: location.display_name,
    address: toAddress(location.address),
  };
}

const ACTION_STATUSES: ReadonlySet<string> = new Set<TerminalReaderActionStatus>([
  'in_progress',
  'succeeded',
  'failed',
]);

/** A provider code is kept only when it looks like one: never prose, never unbounded. */
function codeOf(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : null;
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === 'string') return value;
  return value?.id ?? null;
}

export function toReaderAction(
  action: Stripe.Terminal.Reader.Action | null,
): ProviderTerminalReaderAction | null {
  if (!action || !ACTION_STATUSES.has(action.status)) return null;
  const status = action.status as TerminalReaderActionStatus;
  if (action.type !== 'process_payment_intent') {
    return { type: 'other', status, paymentObjectId: null, failureCode: null };
  }
  return {
    type: 'process_payment_intent',
    status,
    paymentObjectId: idOf(action.process_payment_intent?.payment_intent),
    failureCode: status === 'failed' ? codeOf(action.failure_code) : null,
  };
}

export function toTerminalReader(reader: Stripe.Terminal.Reader): ProviderTerminalReader {
  return {
    providerObjectId: reader.id,
    label: reader.label,
    deviceType: reader.device_type,
    serialNumber: reader.serial_number,
    status: reader.status === 'online' || reader.status === 'offline' ? reader.status : null,
    lastSeenAt: typeof reader.last_seen_at === 'number' ? fromUnix(reader.last_seen_at) : null,
    locationObjectId: idOf(reader.location),
    action: toReaderAction(reader.action),
  };
}

/** A reader read that may be Stripe's deleted shape: `null` when it is gone. */
export function toLiveTerminalReader(
  reader: Stripe.Terminal.Reader | Stripe.Terminal.DeletedReader | null,
): ProviderTerminalReader | null {
  if (reader === null || reader.deleted === true) return null;
  return toTerminalReader(reader);
}
