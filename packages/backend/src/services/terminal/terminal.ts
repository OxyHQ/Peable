/**
 * Terminal (ADR 0024): locations (`tml_…`), readers (`tmr_…`), connection
 * tokens, and collecting a `card_present` PaymentIntent on a reader.
 *
 * - **Creating a location, a reader or a token is a NEW operation**: its mode
 *   is the credential's (`selectCardProvider`). Everything on a stored row
 *   resolves by the row's own `livemode` (`selectStoredProvider`). A mode with
 *   no key, or a provider account without Terminal, is 503
 *   `terminal_unavailable`; nothing falls through to the other key.
 * - **Provider first, row second** for locations and readers
 *   (`schema/terminal.ts` says why), under `tml:` / `tmr:` idempotency keys.
 * - **A reader's action is not a payment.** The money is the PaymentIntent's:
 *   the reader confirms it at the provider, and its outcome moves the intent
 *   only through `applyProviderPaymentResult` / the drain — CAS,
 *   `transitionIntent`, `ensureChargeForIntent`, routing decided at create.
 *   What this module owns is the reader's record of the attempt.
 * - **{@link reconcileReader} is the ONE place** a provider reader read
 *   becomes a change: the device's status, and — only for an attempt Orbit
 *   claimed and the provider acknowledged — its outcome, written once by
 *   compare-and-swap with its `terminal.reader.action_*` event in the same
 *   transaction. The drain, a retrieve, a collection, a cancel and the
 *   simulated tap all go through it.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Address, ProcessPaymentIntentParams } from '@peable.to/shared-types';
import { SIMULATED_READER_REGISTRATION_PREFIX } from '@peable.to/shared-types';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { findIntentById, type PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import {
  acknowledgeReaderAction,
  claimReaderAction,
  deleteTerminalLocation,
  deleteTerminalReader,
  findTerminalReaderById,
  insertTerminalLocation,
  insertTerminalReader,
  locationHasReaders,
  refreshTerminalReaderDevice,
  releaseReaderAction,
  settleReaderAction,
  updateTerminalLocation,
  updateTerminalReader,
  type TerminalLocationRow,
  type TerminalReaderRow,
} from '../../db/terminal/terminalRepository';
import type { MetadataPatch } from '../../db/metadata';
import { getDb } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { toTerminalReaderDTO } from '../../lib/serializeTerminal';
import { recordEvent } from '../events';
import { reconcileIntentWithProvider } from '../intentReconciliation';
import { kickWebhookOutbox } from '../webhookOutbox';
import { selectCardProvider, selectStoredProvider } from '../providers/environmentGuard';
import { assertLiveMoneyAllowed } from '../money/chargeRouting';
import {
  isTerminalProvider,
  ProviderError,
  providerModeOf,
  TERMINAL_READER_BUSY_CODE,
  TERMINAL_READER_OFFLINE_CODE,
  TERMINAL_UNAVAILABLE_CODE,
  type PaymentProvider,
  type ProviderMode,
  type ProviderTerminalReader,
  type TerminalProvider,
} from '../providers/provider';

/** 503 `terminal_unavailable`: no card key in this mode, or the account cannot use Terminal. */
export class TerminalUnavailableError extends Error {
  constructor(mode: ProviderMode) {
    super(`Terminal is not enabled in ${mode} mode on this deployment`);
    this.name = 'TerminalUnavailableError';
  }
}

/** 409 with a reader or location code. */
export class TerminalStateError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'terminal_reader_busy'
      | 'terminal_reader_offline'
      | 'terminal_location_in_use'
      | 'payment_intent_unexpected_state',
  ) {
    super(message);
    this.name = 'TerminalStateError';
  }
}

/** 400 naming the request field. */
export class TerminalParameterError extends Error {
  constructor(
    message: string,
    readonly param: string,
    readonly code: 'parameter_invalid' | 'resource_missing' = 'parameter_invalid',
  ) {
    super(message);
    this.name = 'TerminalParameterError';
  }
}

/** A collection whose provider payment does not exist yet (an interrupted create). 503. */
export class TerminalPaymentNotReadyError extends Error {
  constructor() {
    super('this payment was never completed at the provider; create it again');
    this.name = 'TerminalPaymentNotReadyError';
  }
}

/** A bounded idempotency-key part for a change's content (provider keys are at most 255 characters). */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/**
 * How long a claim waits for the provider's acknowledgement before a reader
 * read is trusted for it anyway: a request that crashed between the claim and
 * the provider's answer must not hold the reader forever.
 */
const UNACKNOWLEDGED_CLAIM_MS = 60_000;

function asTerminal(provider: PaymentProvider | undefined, mode: ProviderMode): TerminalProvider {
  if (!provider || !isTerminalProvider(provider)) throw new TerminalUnavailableError(mode);
  return provider;
}

/** The provider for a NEW Terminal object: the credential's mode. */
function newOperationProvider(merchant: MerchantRow): TerminalProvider {
  return asTerminal(
    selectCardProvider(merchant.environment),
    merchant.environment === 'production' ? 'live' : 'test',
  );
}

/** The provider that acts on a stored row: its own mode's, never the other. */
function storedProvider(row: {
  readonly provider: 'stripe';
  readonly livemode: boolean;
}): TerminalProvider {
  return asTerminal(selectStoredProvider(row.provider, row.livemode), providerModeOf(row.livemode));
}

/** Run a provider call, turning the adapter's Terminal codes into the gateway's answers. */
async function atProvider<T>(mode: ProviderMode, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.code === TERMINAL_UNAVAILABLE_CODE) throw new TerminalUnavailableError(mode);
      if (error.code === TERMINAL_READER_BUSY_CODE) {
        throw new TerminalStateError(
          'the reader is busy with another action',
          'terminal_reader_busy',
        );
      }
      if (error.code === TERMINAL_READER_OFFLINE_CODE) {
        throw new TerminalStateError(
          'the reader is offline: check its power and network, then try again',
          'terminal_reader_offline',
        );
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function createLocation(
  merchant: MerchantRow,
  input: {
    readonly displayName: string;
    readonly address: Address;
    readonly metadata: Record<string, string>;
  },
): Promise<TerminalLocationRow> {
  assertLiveMoneyAllowed(merchant, 'Terminal');
  const provider = newOperationProvider(merchant);
  const mode = providerModeOf(merchant.livemode);
  const publicId = newId('tml');
  const created = await atProvider(mode, () =>
    provider.createTerminalLocation({
      locationId: publicId,
      displayName: input.displayName,
      address: input.address,
      idempotencyKey: `tml:${publicId}`,
    }),
  );
  return insertTerminalLocation(getDb(), {
    publicId,
    merchantId: merchant.id,
    displayName: created.displayName,
    address: created.address.country === null ? input.address : created.address,
    metadata: input.metadata,
    provider: provider.id,
    providerObjectId: created.providerObjectId,
  });
}

export async function updateLocation(
  row: TerminalLocationRow,
  patch: {
    readonly displayName?: string | undefined;
    readonly address?: Address | undefined;
    readonly metadata?: MetadataPatch | undefined;
  },
): Promise<TerminalLocationRow | 'limit_exceeded'> {
  let displayName = patch.displayName;
  let address = patch.address;
  if (displayName !== undefined || address !== undefined) {
    const provider = storedProvider(row);
    const updated = await atProvider(providerModeOf(row.livemode), () =>
      provider.updateTerminalLocation({
        providerObjectId: row.providerObjectId,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(address !== undefined ? { address } : {}),
        // One provider write per distinct change of this location.
        idempotencyKey: `tml:${row.publicId}:update:${digest([displayName, address])}`,
      }),
    );
    displayName = updated.displayName;
    if (address !== undefined && updated.address.country !== null) address = updated.address;
  }
  const result = await updateTerminalLocation(getDb(), row.id, {
    displayName,
    address,
    metadata: patch.metadata,
  });
  if (result === null)
    throw new TerminalParameterError('location not found', 'id', 'resource_missing');
  return result;
}

export async function removeLocation(row: TerminalLocationRow): Promise<void> {
  const db = getDb();
  if (await locationHasReaders(db, row.id)) {
    throw new TerminalStateError(
      'readers are still registered to this location: delete them first',
      'terminal_location_in_use',
    );
  }
  const provider = storedProvider(row);
  await atProvider(providerModeOf(row.livemode), () =>
    provider.deleteTerminalLocation({
      providerObjectId: row.providerObjectId,
      idempotencyKey: `tml:${row.publicId}:delete`,
    }),
  );
  const outcome = await deleteTerminalLocation(db, row.id);
  if (outcome === 'in_use') {
    throw new TerminalStateError(
      'a reader was registered to this location while it was being deleted',
      'terminal_location_in_use',
    );
  }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export async function registerReader(
  merchant: MerchantRow,
  location: TerminalLocationRow,
  input: {
    readonly registrationCode: string;
    readonly label?: string | undefined;
    readonly metadata: Record<string, string>;
  },
): Promise<TerminalReaderRow> {
  if (
    merchant.livemode &&
    input.registrationCode.startsWith(SIMULATED_READER_REGISTRATION_PREFIX)
  ) {
    throw new TerminalParameterError(
      'a simulated reader is registered in test mode only',
      'registration_code',
    );
  }
  assertLiveMoneyAllowed(merchant, 'Terminal');
  const provider = newOperationProvider(merchant);
  const publicId = newId('tmr');
  const registered = await atProvider(providerModeOf(merchant.livemode), () =>
    provider.registerTerminalReader({
      readerId: publicId,
      registrationCode: input.registrationCode,
      ...(input.label !== undefined ? { label: input.label } : {}),
      locationObjectId: location.providerObjectId,
      idempotencyKey: `tmr:${publicId}`,
    }),
  );
  return insertTerminalReader(getDb(), {
    publicId,
    merchantId: merchant.id,
    locationId: location.id,
    label: registered.label,
    deviceType: registered.deviceType,
    serialNumber: registered.serialNumber,
    status: registered.status,
    lastSeenAt: registered.lastSeenAt,
    metadata: input.metadata,
    provider: provider.id,
    providerObjectId: registered.providerObjectId,
  });
}

export async function updateReader(
  row: TerminalReaderRow,
  patch: { readonly label?: string | undefined; readonly metadata?: MetadataPatch | undefined },
): Promise<TerminalReaderRow | 'limit_exceeded'> {
  let label = patch.label;
  if (label !== undefined) {
    const provider = storedProvider(row);
    const wanted = label;
    const updated = await atProvider(providerModeOf(row.livemode), () =>
      provider.updateTerminalReader({
        providerObjectId: row.providerObjectId,
        label: wanted,
        idempotencyKey: `tmr:${row.publicId}:label:${digest(wanted)}`,
      }),
    );
    label = updated.label;
  }
  const result = await updateTerminalReader(getDb(), row.id, { label, metadata: patch.metadata });
  if (result === null)
    throw new TerminalParameterError('reader not found', 'id', 'resource_missing');
  return result;
}

export async function removeReader(row: TerminalReaderRow): Promise<void> {
  const current = await reconcileReader(row);
  if (current.action?.status === 'in_progress') {
    throw new TerminalStateError(
      'the reader is collecting a payment: cancel its action first',
      'terminal_reader_busy',
    );
  }
  const provider = storedProvider(row);
  await atProvider(providerModeOf(row.livemode), () =>
    provider.deleteTerminalReader({
      providerObjectId: row.providerObjectId,
      idempotencyKey: `tmr:${row.publicId}:delete`,
    }),
  );
  const outcome = await deleteTerminalReader(getDb(), row.id);
  if (outcome === 'busy') {
    throw new TerminalStateError('the reader started collecting a payment', 'terminal_reader_busy');
  }
}

/**
 * Make the row agree with the provider's reader — the ONE path (module
 * comment). `providerRead` is a read the caller already holds; otherwise the
 * provider is asked. Never moves an action backwards, never writes an outcome
 * for an attempt the provider has not acknowledged (until the claim is stale),
 * and never writes one twice.
 */
export async function reconcileReader(
  row: TerminalReaderRow,
  providerRead?: ProviderTerminalReader | null,
): Promise<TerminalReaderRow> {
  const read =
    providerRead !== undefined
      ? providerRead
      : await atProvider(providerModeOf(row.livemode), () =>
          storedProvider(row).getTerminalReader(row.providerObjectId),
        );
  const db = getDb();
  let current = row;
  if (read !== null) {
    current =
      (await refreshTerminalReaderDevice(db, row.id, {
        status: read.status,
        lastSeenAt: read.lastSeenAt,
        label: read.label,
        deviceType: read.deviceType,
      })) ?? current;
  }

  const action = current.action;
  if (action === null || action.status !== 'in_progress') return current;
  const acknowledged =
    action.acknowledgedAt !== null ||
    Date.now() - action.startedAt.getTime() > UNACKNOWLEDGED_CLAIM_MS;
  if (!acknowledged) return current;

  const intent = await findIntentById(db, action.paymentIntentId);
  const seen = read?.action ?? null;
  const aboutThis =
    seen !== null &&
    seen.type === 'process_payment_intent' &&
    intent !== null &&
    seen.paymentObjectId === intent.providerObjectId;
  if (aboutThis && seen.status === 'in_progress') return current;
  // Settled by the provider — or no longer this collection at all (the reader
  // was reset, deleted, or another action replaced it). The reader's word is
  // not the payment's: before telling the merchant the attempt FAILED (on
  // which an integration retries), the PaymentIntent is read — one that was
  // authorized or paid is a succeeded attempt, whatever the reader shows now.
  let outcome:
    | { readonly status: 'succeeded' }
    | { readonly status: 'failed'; readonly failureCode: string | null };
  if (aboutThis && seen.status === 'succeeded') {
    outcome = { status: 'succeeded' };
  } else {
    const paid = await paymentWasTaken(intent);
    if (paid === null && !aboutThis) return current; // unknown: a later read decides
    outcome =
      paid === true
        ? { status: 'succeeded' }
        : { status: 'failed', failureCode: aboutThis ? seen.failureCode : null };
  }

  const settled = await db.transaction(async (tx) => {
    const moved = await settleReaderAction(tx, current.id, action.startedAt, outcome);
    if (!moved) return null;
    await recordEvent(tx, {
      merchantId: moved.merchantId,
      type:
        outcome.status === 'succeeded'
          ? 'terminal.reader.action_succeeded'
          : 'terminal.reader.action_failed',
      object: toTerminalReaderDTO(moved),
      previousAttributes: { action: { status: 'in_progress' } },
    });
    return moved;
  });
  if (!settled) return (await findTerminalReaderById(db, row.id)) ?? current;
  kickWebhookOutbox();
  // The payment moves on its own path — the provider's word through the one
  // reconciliation, CAS on its status. A decline's `payment_failed` comes with
  // the provider's `payment_intent.payment_failed`; a success is applied here
  // too so the merchant does not wait on the webhook.
  if (intent !== null) await reconcileIntentWithProvider(intent);
  return settled;
}

/**
 * Whether the provider authorized or captured the payment: `null` when it
 * cannot be read (or there is nothing to read).
 */
async function paymentWasTaken(intent: PaymentIntentRow | null): Promise<boolean | null> {
  if (intent === null || !intent.provider || !intent.providerObjectId) return null;
  if (intent.status === 'succeeded' || intent.status === 'requires_capture') return true;
  const provider = selectStoredProvider(intent.provider, intent.livemode);
  if (!provider) return null;
  try {
    const status = (await provider.getStatus(intent.providerObjectId)).status;
    return status === 'succeeded' || status === 'requires_capture' || status === 'processing';
  } catch {
    return null;
  }
}

/** A refusal that leaves the reader exactly as it was: the provider never took the collection. */
function isDefinitiveRefusal(error: unknown): boolean {
  return (
    error instanceof TerminalStateError ||
    error instanceof TerminalUnavailableError ||
    (error instanceof ProviderError && !error.retryable)
  );
}

/**
 * Collect a `card_present` PaymentIntent on the reader: claim the reader
 * (CAS), hand the provider the collection under a key derived from the claim,
 * then apply what the provider answered. A refusal gives the claim back.
 */
export async function processPaymentIntent(
  merchant: MerchantRow,
  row: TerminalReaderRow,
  intent: PaymentIntentRow,
  config: ProcessPaymentIntentParams['process_config'],
): Promise<TerminalReaderRow> {
  if (row.merchantId !== merchant.id || intent.merchantId !== merchant.id) {
    throw new TerminalParameterError(
      'no such payment intent',
      'payment_intent',
      'resource_missing',
    );
  }
  // Taking a card is a live money path: gated like a destination charge
  // (ADR 0015) for a merchant that is not an Oxy product.
  assertLiveMoneyAllowed(merchant, 'Terminal');
  if (intent.rail !== 'card' || intent.paymentMethodTypes?.join() !== 'card_present') {
    throw new TerminalParameterError(
      "a reader collects a PaymentIntent created with payment_method_types ['card_present']",
      'payment_intent',
    );
  }
  if (intent.livemode !== row.livemode) {
    // Unreachable for one merchant's rows; refused rather than sent with either key.
    throw new TerminalParameterError('the PaymentIntent is in the other mode', 'payment_intent');
  }
  if (intent.status !== 'requires_payment_method') {
    throw new TerminalStateError(
      `this PaymentIntent is '${intent.status}'; a reader collects one that requires a payment method`,
      'payment_intent_unexpected_state',
    );
  }
  if (!intent.providerObjectId) throw new TerminalPaymentNotReadyError();
  const paymentObjectId = intent.providerObjectId;
  const provider = storedProvider(row);
  const mode = providerModeOf(row.livemode);
  const enableCustomerCancellation = config?.enable_customer_cancellation ?? false;

  const db = getDb();
  const claimInput = { paymentIntentId: intent.id, enableCustomerCancellation };
  // What the claim replaces, read right before it: a refusal gives the reader
  // back exactly this — never an earlier read (which could resurrect an
  // attempt the provider has since settled, and settle it twice).
  let before = (await findTerminalReaderById(db, row.id))?.action ?? null;
  let claimed = await claimReaderAction(db, row.id, claimInput);
  if (claimed === 'intent_busy') {
    throw new TerminalStateError(
      'another reader is already collecting this PaymentIntent: cancel that collection first',
      'payment_intent_unexpected_state',
    );
  }
  if (!claimed) {
    // Orbit still thinks it busy: ask the provider whether that is still true.
    before = (await reconcileReader(row)).action;
    claimed = await claimReaderAction(db, row.id, claimInput);
    if (claimed === 'intent_busy') {
      throw new TerminalStateError(
        'another reader is already collecting this PaymentIntent: cancel that collection first',
        'payment_intent_unexpected_state',
      );
    }
  }
  const claim = claimed?.action;
  if (!claimed || !claim) {
    throw new TerminalStateError(
      'the reader is collecting another payment: wait for it, or cancel its action',
      'terminal_reader_busy',
    );
  }

  let answered: ProviderTerminalReader;
  try {
    answered = await atProvider(mode, () =>
      provider.processTerminalPayment({
        readerObjectId: row.providerObjectId,
        paymentObjectId,
        enableCustomerCancellation,
        idempotencyKey: `tmrpi:${row.publicId}:${claim.startedAt.getTime()}`,
      }),
    );
  } catch (error) {
    // A definitive refusal leaves the reader as it was: the claim is given
    // back. Anything else (a timeout, a 5xx) may have reached the reader —
    // the claim stays, so the reader is not shown idle (or deleted) mid-tap,
    // and the provider's own read settles it once the claim is stale.
    if (isDefinitiveRefusal(error)) {
      await releaseReaderAction(db, row.id, claim.startedAt, before);
    }
    throw error;
  }
  const acknowledged = (await acknowledgeReaderAction(db, row.id, claim.startedAt)) ?? claimed;
  return reconcileReader(acknowledged, answered);
}

export async function cancelReaderAction(row: TerminalReaderRow): Promise<TerminalReaderRow> {
  const provider = storedProvider(row);
  const answered = await atProvider(providerModeOf(row.livemode), () =>
    provider.cancelTerminalReaderAction({
      readerObjectId: row.providerObjectId,
      // A fresh key per request: a replayed answer would be a stale reader read.
      idempotencyKey: `tmrca:${row.publicId}:${randomUUID()}`,
    }),
  );
  return reconcileReader(row, answered);
}

/** TEST MODE: a test card tapped on a simulated reader — a fake input to the real path. */
export async function presentPaymentMethod(row: TerminalReaderRow): Promise<TerminalReaderRow> {
  // A reader that is not collecting anything is refused by the provider, in its own words.
  const provider = storedProvider(row);
  const answered = await atProvider(providerModeOf(row.livemode), () =>
    provider.presentTerminalPaymentMethod({
      readerObjectId: row.providerObjectId,
      idempotencyKey: `tmrpm:${row.publicId}:${randomUUID()}`,
    }),
  );
  return reconcileReader(row, answered);
}

// ---------------------------------------------------------------------------
// Connection tokens
// ---------------------------------------------------------------------------

/**
 * A connection token is ALWAYS limited to one of the merchant's locations:
 * readers live on the one platform account every merchant shares, and an
 * unscoped token reaches every reader on it — another merchant's included.
 */
export async function createConnectionToken(
  merchant: MerchantRow,
  location: TerminalLocationRow,
): Promise<{ readonly secret: string }> {
  if (location.merchantId !== merchant.id) {
    throw new TerminalParameterError('no such location', 'location', 'resource_missing');
  }
  assertLiveMoneyAllowed(merchant, 'Terminal');
  const provider = newOperationProvider(merchant);
  return atProvider(providerModeOf(merchant.livemode), () =>
    provider.createTerminalConnectionToken({ locationObjectId: location.providerObjectId }),
  );
}
