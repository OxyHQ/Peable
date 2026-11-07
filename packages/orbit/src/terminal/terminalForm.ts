import type {
  CreateTerminalLocationParams,
  CreateTerminalReaderParams,
  PaymentIntent,
  TerminalLocation,
  TerminalReader,
  TerminalReaderActionStatus,
  TerminalReaderStatus,
} from '@peable.to/shared-types';
import type { CollectOnReaderBody, OrbitEnvironment } from '../api/dashboard';
import { isOrbitApiError } from '../api/transport';
import { normalizeCurrency, ORBIT_CURRENCY_DECIMALS, parseAmountInput } from '../format/money';
import type { StatusTone } from '../payments/status';

/**
 * Terminal as pure data (ADR 0024): the location, reader and "collect a
 * payment" forms with the exact request bodies, where a collection stands, and
 * which refusal a gateway answer is.
 *
 * The value sets are restated rather than imported: the
 * `@peable.to/shared-types` root barrel also exports the `node:crypto` webhook
 * signer, which a browser bundle cannot load. `terminalForm.test.ts` pins each
 * one to its shared-types original.
 */

export const ORBIT_READER_STATUSES: readonly TerminalReaderStatus[] = ['online', 'offline'];

export const ORBIT_READER_ACTION_STATUSES: readonly TerminalReaderActionStatus[] = [
  'in_progress',
  'succeeded',
  'failed',
];

/** `SIMULATED_READER_REGISTRATION_PREFIX`: a code the provider answers with a simulated reader. */
export const ORBIT_SIMULATED_PREFIX = 'simulated-';

/** The simulated codes the form suggests in test mode. */
export const ORBIT_SIMULATED_CODES = ['simulated-wpe', 'simulated-s700'] as const;

/** Field bounds (`TERMINAL_LIMITS`). */
export const ORBIT_TERMINAL_LIMITS = {
  displayNameMax: 100,
  labelMax: 100,
  registrationCodeMax: 100,
} as const;

/** Address bounds the gateway checks (`addressParams`). */
const ADDRESS_LINE_MAX = 500;
const POSTAL_CODE_MAX = 40;
const DESCRIPTION_MAX = 500;

/** How often the reader is asked again while its action runs. */
export const READER_POLL_MS = 2000;
/** How many times a collected payment's status is read again before Orbit stops asking. */
export const PAYMENT_POLL_LIMIT = 30;

/** Test mode: the only mode with simulated readers and the "Simulate tap" helper. */
export function isTestMode(environment: OrbitEnvironment): boolean {
  return environment !== 'production';
}

// --- Locations -----------------------------------------------------------

export interface LocationForm {
  displayName: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, any case as typed. */
  country: string;
}

export const EMPTY_LOCATION_FORM: LocationForm = {
  displayName: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
};

/** A location's fields as its edit form starts. */
export function locationFormOf(location: TerminalLocation): LocationForm {
  const address = location.address;
  return {
    displayName: location.display_name,
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    city: address.city ?? '',
    state: address.state ?? '',
    postalCode: address.postal_code ?? '',
    country: address.country ?? '',
  };
}

export type LocationFormError = 'displayName' | 'country' | 'line' | 'postalCode';

export type FormResult<T, E extends string> = { ok: true; body: T } | { ok: false; error: E };

/**
 * The create (and full update) body, or the first field the gateway would
 * refuse. The address is sent whole — an update replaces it — with only the
 * lines that were filled in.
 */
export function buildLocationBody(
  form: LocationForm,
): FormResult<CreateTerminalLocationParams, LocationFormError> {
  const displayName = form.displayName.trim();
  if (displayName === '' || displayName.length > ORBIT_TERMINAL_LIMITS.displayNameMax) {
    return { ok: false, error: 'displayName' };
  }
  const country = form.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, error: 'country' };
  const lines = {
    line1: form.line1.trim(),
    line2: form.line2.trim(),
    city: form.city.trim(),
    state: form.state.trim(),
  };
  if (Object.values(lines).some((line) => line.length > ADDRESS_LINE_MAX)) {
    return { ok: false, error: 'line' };
  }
  const postalCode = form.postalCode.trim();
  if (postalCode.length > POSTAL_CODE_MAX) return { ok: false, error: 'postalCode' };
  const address: CreateTerminalLocationParams['address'] = { country };
  for (const [key, value] of Object.entries(lines) as [keyof typeof lines, string][]) {
    if (value !== '') address[key] = value;
  }
  if (postalCode !== '') address.postal_code = postalCode;
  return { ok: true, body: { display_name: displayName, address } };
}

/** One line for a location's address: `1 Main St, Springfield, US`. */
export function addressLine(location: Pick<TerminalLocation, 'address'>): string {
  const a = location.address;
  return [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' '), a.state, a.country]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(', ');
}

// --- Readers -------------------------------------------------------------

export interface ReaderForm {
  registrationCode: string;
  /** The location's `tml_…`, or empty before one is picked. */
  location: string;
  label: string;
}

export const EMPTY_READER_FORM: ReaderForm = { registrationCode: '', location: '', label: '' };

export type ReaderFormError = 'registrationCode' | 'simulatedInLive' | 'location' | 'label';

/**
 * The register body, or why not. A simulated code is refused in live mode
 * here, before the gateway refuses it: a live reader is a device someone holds.
 */
export function buildReaderBody(
  form: ReaderForm,
  environment: OrbitEnvironment,
): FormResult<CreateTerminalReaderParams, ReaderFormError> {
  const code = form.registrationCode.trim();
  if (code === '' || code.length > ORBIT_TERMINAL_LIMITS.registrationCodeMax) {
    return { ok: false, error: 'registrationCode' };
  }
  if (!isTestMode(environment) && code.toLowerCase().startsWith(ORBIT_SIMULATED_PREFIX)) {
    return { ok: false, error: 'simulatedInLive' };
  }
  if (!form.location.startsWith('tml_')) return { ok: false, error: 'location' };
  const label = form.label.trim();
  if (label.length > ORBIT_TERMINAL_LIMITS.labelMax) return { ok: false, error: 'label' };
  return {
    ok: true,
    body: {
      registration_code: code,
      location: form.location,
      ...(label !== '' ? { label } : {}),
    },
  };
}

/** A new label for a reader, or `null` when the gateway would refuse it. */
export function parseLabel(text: string): string | null {
  const label = text.trim();
  return label === '' || label.length > ORBIT_TERMINAL_LIMITS.labelMax ? null : label;
}

/** The `tml_…` a reader is registered to, whether or not the location was expanded. */
export function readerLocationId(reader: Pick<TerminalReader, 'location'>): string | null {
  const location = reader.location;
  if (location === null) return null;
  return typeof location === 'string' ? location : location.id;
}

export function readerStatusTone(status: TerminalReaderStatus | null): StatusTone {
  if (status === 'online') return 'success';
  if (status === 'offline') return 'neutral';
  return 'neutral';
}

// --- Collect a payment ---------------------------------------------------

/** The currencies a reader can be asked for: every fiat currency Orbit knows. FairCoin never. */
export const READER_CURRENCIES = Object.keys(ORBIT_CURRENCY_DECIMALS).filter(
  (code) => code !== 'FAIR',
) as CollectOnReaderBody['currency'][];

const COUNTRY_CURRENCY: Readonly<Record<string, CollectOnReaderBody['currency']>> = {
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  AU: 'AUD',
  CH: 'CHF',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
  CZ: 'CZK',
  JP: 'JPY',
};

/** The currency a reader at `country` most likely takes: its own, else EUR. */
export function defaultCurrencyFor(country: string | null | undefined): string {
  return COUNTRY_CURRENCY[(country ?? '').toUpperCase()] ?? 'EUR';
}

export interface CollectForm {
  /** As typed: `12.50`. */
  amount: string;
  currency: string;
  description: string;
  /** Authorize now and capture later (`capture_method: 'manual'`). */
  manualCapture: boolean;
}

export type CollectFormError = 'currency' | 'amount' | 'description';

/** The collect body, the amount converted to base units exactly — or the first field at fault. */
export function buildCollectBody(
  form: CollectForm,
): FormResult<CollectOnReaderBody, CollectFormError> {
  const currency = normalizeCurrency(form.currency);
  if (!(READER_CURRENCIES as readonly string[]).includes(currency)) {
    return { ok: false, error: 'currency' };
  }
  const amount = parseAmountInput(form.amount, currency);
  if (amount === null) return { ok: false, error: 'amount' };
  const description = form.description.trim();
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: 'description' };
  return {
    ok: true,
    body: {
      amount,
      currency: currency as CollectOnReaderBody['currency'],
      ...(description !== '' ? { description } : {}),
      ...(form.manualCapture ? { capture_method: 'manual' as const } : {}),
    },
  };
}

/** The payment the reader is collecting, or last collected. */
export function actionPaymentIntent(reader: Pick<TerminalReader, 'action'>): string | null {
  return reader.action?.process_payment_intent.payment_intent ?? null;
}

/** Whether the reader is mid-collection — poll it, offer Cancel and (in test mode) Simulate tap. */
export function isCollecting(reader: Pick<TerminalReader, 'action'>): boolean {
  return reader.action?.status === 'in_progress';
}

const DECLINE_CODES = new Set(['card_declined']);
const STOPPED_CODES = new Set(['customer_canceled', 'request_canceled']);

/**
 * Where the reader's last collection stands, from the reader's action and the
 * payment it collected:
 *
 * - `none`        the reader has collected nothing yet
 * - `collecting`  the reader is waiting for (or reading) the card
 * - `settling`    the reader finished; the payment's outcome has not arrived
 * - `succeeded`   paid
 * - `authorized`  authorized, awaiting capture (manual capture)
 * - `declined`    the card was declined — `message` is the payment's own sentence
 * - `stopped`     cancelled on the reader or from Orbit before a card was read
 * - `failed`      the reader could not complete it — `message` says why
 * - `canceled`    the payment itself was cancelled
 *
 * Every outcome but `succeeded` / `authorized` / `canceled` leaves nothing
 * charged, and the amount can be collected again.
 */
export type CollectionOutcome =
  | { kind: 'none' }
  | { kind: 'collecting' }
  | { kind: 'settling' }
  | { kind: 'succeeded' }
  | { kind: 'authorized' }
  | { kind: 'canceled' }
  | { kind: 'declined'; message: string | null }
  | { kind: 'stopped' }
  | { kind: 'failed'; message: string | null };

export function collectionOutcome(
  reader: Pick<TerminalReader, 'action'>,
  intent: Pick<PaymentIntent, 'status' | 'last_payment_error'> | undefined,
): CollectionOutcome {
  const action = reader.action;
  if (!action) return { kind: 'none' };
  if (action.status === 'in_progress') return { kind: 'collecting' };
  if (intent?.status === 'succeeded') return { kind: 'succeeded' };
  if (intent?.status === 'requires_capture') return { kind: 'authorized' };
  if (intent?.status === 'canceled') return { kind: 'canceled' };
  const paymentError = intent?.last_payment_error?.message ?? null;
  if (action.status === 'failed') {
    const code = action.failure_code ?? '';
    if (STOPPED_CODES.has(code)) return { kind: 'stopped' };
    if (DECLINE_CODES.has(code) || paymentError !== null) {
      return { kind: 'declined', message: paymentError ?? action.failure_message };
    }
    return { kind: 'failed', message: action.failure_message };
  }
  // The reader succeeded: the payment's own outcome is on its way.
  if (intent?.status === 'requires_payment_method' && paymentError !== null) {
    return { kind: 'declined', message: paymentError };
  }
  return { kind: 'settling' };
}

/** Whether the collected payment's status is worth reading again. */
export function paymentStillSettling(outcome: CollectionOutcome): boolean {
  return outcome.kind === 'settling';
}

export function outcomeTone(outcome: CollectionOutcome): StatusTone {
  switch (outcome.kind) {
    case 'succeeded':
    case 'authorized':
      return 'success';
    case 'collecting':
    case 'settling':
      return 'info';
    case 'declined':
    case 'failed':
      return 'danger';
    case 'stopped':
    case 'canceled':
      return 'warning';
    case 'none':
      return 'neutral';
  }
}

// --- Refusals ------------------------------------------------------------

export type TerminalRefusal =
  | 'unavailable'
  | 'locationInUse'
  | 'readerBusy'
  | 'readerOffline'
  | 'liveGated'
  | 'testOnly'
  | 'registrationCode'
  | null;

/**
 * Which Terminal refusal an error is. Anything else is the gateway's own
 * message, with its request id.
 */
export function terminalRefusal(error: unknown): TerminalRefusal {
  if (!isOrbitApiError(error)) return null;
  switch (error.code) {
    case 'terminal_unavailable':
      return 'unavailable';
    case 'terminal_location_in_use':
      return 'locationInUse';
    case 'terminal_reader_busy':
      return 'readerBusy';
    case 'terminal_reader_offline':
      return 'readerOffline';
    case 'live_payments_gated':
      return 'liveGated';
    case 'test_mode_only':
      return 'testOnly';
  }
  if (error.status === 400 && error.param === 'registration_code') return 'registrationCode';
  return null;
}
