/**
 * Identity verification sessions (`vs_…`, ADR 0023) over the provider's
 * hosted flow.
 *
 * - **A new session is a new operation**: its mode is the credential's
 *   (`selectProvider`), and every later call on it resolves by the row's own
 *   `livemode` (`selectStoredProvider`). A mode with no key — or a provider
 *   account without Identity — is 503 `identity_unavailable`; nothing falls
 *   through to the other key.
 * - **Provider first, row second** (`schema/identity.ts` says why), under the
 *   provider idempotency key `vs:<public id>`.
 * - **{@link applyVerificationSnapshot} is the ONE place** a provider session
 *   becomes a change here: compare-and-swap on the status it read, the report's
 *   outcomes recorded once, and the `identity.verification_session.*` event in
 *   the same transaction. The drain, a retrieve, a cancel and a redaction all
 *   go through it.
 * - **Nothing about the person is stored**: the adapter hands over verdicts
 *   only, `url` / `client_secret` are passed through to the caller, and
 *   `verified_outputs` is read live for one answer.
 */
import type {
  CreateVerificationSessionParams,
  VerificationOptionsParams,
  VerificationSessionStatus,
  VerificationSessionType,
  WebhookEventType,
} from '@peable.to/shared-types';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  findVerificationSessionById,
  insertVerificationSession,
  recordVerificationReport,
  updateVerificationSessionConfig,
  updateVerificationSessionState,
  type VerificationSessionRow,
} from '../../db/identity/verificationRepository';
import { redactVerificationSessionEvents } from '../../db/events/eventRepository';
import type { VerificationOptions } from '../../db/schema/identity';
import type { MetadataPatch } from '../../db/metadata';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import {
  toVerificationSessionDTO,
  type VerificationSessionLive,
} from '../../lib/serializeIdentity';
import { recordEvent } from '../events';
import { kickWebhookOutbox } from '../webhookOutbox';
import { selectProvider, selectStoredProvider } from '../providers/environmentGuard';
import {
  IDENTITY_UNAVAILABLE_CODE,
  isIdentityVerifyingProvider,
  ProviderError,
  type IdentityVerifyingProvider,
  type PaymentProvider,
  type ProviderVerificationOptions,
  type ProviderVerificationSession,
} from '../providers/provider';

/** 503 `identity_unavailable`: no provider key in this mode, or the account cannot use Identity. */
export class IdentityUnavailableError extends Error {
  constructor(mode: 'test' | 'live') {
    super(`identity verification is not enabled in ${mode} mode on this deployment`);
    this.name = 'IdentityUnavailableError';
  }
}

/** 409 `verification_session_unexpected_state`. */
export class VerificationSessionStateError extends Error {
  constructor(row: VerificationSessionRow, action: string) {
    super(
      row.redactionStatus !== null
        ? `this verification session is redacted and cannot be ${action}`
        : `this verification session is '${row.status}' and cannot be ${action}`,
    );
    this.name = 'VerificationSessionStateError';
  }
}

/** 400 on a request field the session's type does not take. */
export class VerificationParameterError extends Error {
  constructor(
    message: string,
    readonly param: string,
  ) {
    super(message);
    this.name = 'VerificationParameterError';
  }
}

/** Legal moves — Stripe's lifecycle: `verified` and `canceled` are terminal. */
const ALLOWED: Record<VerificationSessionStatus, readonly VerificationSessionStatus[]> = {
  requires_input: ['processing', 'verified', 'canceled'],
  processing: ['requires_input', 'verified', 'canceled'],
  verified: [],
  canceled: [],
};

export function isValidVerificationTransition(
  from: VerificationSessionStatus,
  to: VerificationSessionStatus,
): boolean {
  return ALLOWED[from].includes(to);
}

const STATUS_EVENT: Record<VerificationSessionStatus, WebhookEventType> = {
  requires_input: 'identity.verification_session.requires_input',
  processing: 'identity.verification_session.processing',
  verified: 'identity.verification_session.verified',
  canceled: 'identity.verification_session.canceled',
};

function modeOf(livemode: boolean): 'test' | 'live' {
  return livemode ? 'live' : 'test';
}

function asIdentityProvider(
  provider: PaymentProvider | undefined,
  mode: 'test' | 'live',
): IdentityVerifyingProvider {
  if (!provider || !isIdentityVerifyingProvider(provider)) throw new IdentityUnavailableError(mode);
  return provider;
}

/** The provider that acts on a stored session: its own mode's, never the other. */
function storedProvider(row: VerificationSessionRow): IdentityVerifyingProvider {
  return asIdentityProvider(selectStoredProvider(row.provider, row.livemode), modeOf(row.livemode));
}

/** Run a provider call, turning "this account has no Identity" into the 503. */
async function atProvider<T>(mode: 'test' | 'live', call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProviderError && error.code === IDENTITY_UNAVAILABLE_CODE) {
      throw new IdentityUnavailableError(mode);
    }
    throw error;
  }
}

/**
 * The wire options a session stores: the document check's four fields (`null`
 * when not set) on a `document` session, `{ id_number: {} }` on the other.
 */
export function normalizeVerificationOptions(
  type: VerificationSessionType,
  options: VerificationOptionsParams | undefined,
): VerificationOptions {
  if (type === 'id_number') {
    if (options?.document !== undefined) {
      throw new VerificationParameterError(
        'document options apply to a document verification session',
        'options[document]',
      );
    }
    return { id_number: {} };
  }
  const document = options?.document;
  return {
    document: {
      allowed_types: document?.allowed_types ? [...new Set(document.allowed_types)] : null,
      require_id_number: document?.require_id_number ?? null,
      require_live_capture: document?.require_live_capture ?? null,
      require_matching_selfie: document?.require_matching_selfie ?? null,
    },
  };
}

function toProviderOptions(options: VerificationOptions): ProviderVerificationOptions {
  const document = options.document;
  if (document === undefined) return {};
  return {
    document: {
      ...(document.allowed_types !== null ? { allowedTypes: document.allowed_types } : {}),
      ...(document.require_id_number !== null
        ? { requireIdNumber: document.require_id_number }
        : {}),
      ...(document.require_live_capture !== null
        ? { requireLiveCapture: document.require_live_capture }
        : {}),
      ...(document.require_matching_selfie !== null
        ? { requireMatchingSelfie: document.require_matching_selfie }
        : {}),
    },
  };
}

async function recordSessionEvent(
  tx: DatabaseOrTransaction,
  row: VerificationSessionRow,
  type: WebhookEventType,
): Promise<void> {
  await recordEvent(tx, {
    merchantId: row.merchantId,
    type: type as 'identity.verification_session.created',
    object: toVerificationSessionDTO(row),
  });
}

export interface CreatedVerificationSession {
  readonly row: VerificationSessionRow;
  readonly live: VerificationSessionLive;
}

/**
 * Create a session at the provider of the merchant's own mode, then the row
 * and its `created` event in one transaction.
 *
 * @throws {IdentityUnavailableError} (503) / {@link VerificationParameterError} (400) / `ProviderError`.
 */
export async function createVerificationSession(
  merchant: MerchantRow,
  input: Omit<CreateVerificationSessionParams, 'metadata' | 'expand'> & {
    readonly metadata: Record<string, string>;
  },
): Promise<CreatedVerificationSession> {
  const mode = merchant.environment === 'production' ? 'live' : 'test';
  const options = normalizeVerificationOptions(input.type, input.options);
  const provider = asIdentityProvider(selectProvider('stripe', merchant.environment), mode);
  const publicId = newId('vs');
  const session = await atProvider(mode, () =>
    provider.createVerificationSession({
      verificationSessionId: publicId,
      type: input.type,
      options: toProviderOptions(options),
      returnUrl: input.return_url ?? null,
      idempotencyKey: `vs:${publicId}`,
    }),
  );
  const row = await getDb().transaction(async (tx) => {
    const inserted = await insertVerificationSession(tx, {
      publicId,
      merchantId: merchant.id,
      type: input.type,
      status: 'requires_input',
      options,
      returnUrl: input.return_url ?? null,
      clientReferenceId: input.client_reference_id ?? null,
      metadata: input.metadata,
      provider: provider.id,
      providerObjectId: session.providerObjectId,
    });
    await recordSessionEvent(tx, inserted, 'identity.verification_session.created');
    return inserted;
  });
  kickWebhookOutbox();
  return { row, live: { clientSecret: session.clientSecret, url: session.url } };
}

export type VerificationApplyOutcome =
  | { readonly kind: 'applied'; readonly row: VerificationSessionRow }
  | { readonly kind: 'agreed'; readonly row: VerificationSessionRow }
  | { readonly kind: 'irreconcilable'; readonly error: string };

class StaleVerificationSession extends Error {
  constructor() {
    super('the verification session moved underneath the update');
  }
}

/**
 * Move a session to what the provider says — the ONE place a provider
 * verification session becomes a change here.
 *
 * In one transaction: the newest report's outcomes (once), the CAS on the
 * status this was decided from, the erasure a redaction owes (the row's
 * reference and metadata, and the same in its stored events), and the events —
 * one per status reached, `requires_input` again for a new failure without a
 * status move, and `redacted` when the provider finished erasing.
 */
export async function applyVerificationSnapshot(
  row: VerificationSessionRow,
  snapshot: ProviderVerificationSession,
): Promise<VerificationApplyOutcome> {
  const statusMoves = snapshot.status !== row.status;
  if (statusMoves && !isValidVerificationTransition(row.status, snapshot.status)) {
    return {
      kind: 'irreconcilable',
      error: `a verification session that is '${row.status}' cannot become '${snapshot.status}'`,
    };
  }
  const lastError = snapshot.lastError === null ? null : { code: snapshot.lastError.errorCode };
  const errorChanged =
    (lastError !== null) !== row.hasLastError ||
    (lastError !== null && lastError.code !== row.lastErrorCode);
  // Redaction is irreversible: once `redacted`, nothing walks it back.
  const redactionStatus =
    row.redactionStatus === 'redacted' ? 'redacted' : (snapshot.redaction ?? row.redactionStatus);
  const redactionChanged = redactionStatus !== row.redactionStatus;
  const report = snapshot.lastReport;
  // A report may be new (recorded once below) even when nothing else moved.
  if (!statusMoves && !errorChanged && !redactionChanged && report === null) {
    return { kind: 'agreed', row };
  }

  const moved = await getDb()
    .transaction(async (tx) => {
      const recorded =
        report === null
          ? false
          : await recordVerificationReport(tx, {
              publicId: newId('vr'),
              merchantId: row.merchantId,
              verificationSessionId: row.id,
              type: report.type,
              options: row.options,
              document: report.document,
              idNumber: report.idNumber,
              selfie: report.selfie,
              provider: row.provider,
              providerObjectId: report.providerObjectId,
            });
      if (!statusMoves && !errorChanged && !redactionChanged && !recorded) return null;
      const change = await updateVerificationSessionState(tx, row.id, {
        from: row.status,
        status: snapshot.status,
        lastError,
        redactionStatus,
      });
      if (change.kind !== 'updated') throw new StaleVerificationSession();
      if (row.redactionStatus === null && redactionStatus !== null) {
        await redactVerificationSessionEvents(tx, row.merchantId, row.publicId);
      }
      if (statusMoves) {
        await recordSessionEvent(tx, change.row, STATUS_EVENT[change.row.status]);
      } else if (snapshot.status === 'requires_input' && errorChanged && lastError !== null) {
        await recordSessionEvent(tx, change.row, 'identity.verification_session.requires_input');
      }
      if (redactionStatus === 'redacted' && row.redactionStatus !== 'redacted') {
        await recordSessionEvent(tx, change.row, 'identity.verification_session.redacted');
      }
      return change.row;
    })
    .catch((error: unknown) => {
      if (error instanceof StaleVerificationSession) return undefined;
      throw error;
    });
  if (moved === undefined) {
    return { kind: 'agreed', row: (await findVerificationSessionById(getDb(), row.id)) ?? row };
  }
  if (moved === null) return { kind: 'agreed', row };
  kickWebhookOutbox();
  return { kind: 'applied', row: moved };
}

/** Whether the provider still has something to tell about this session. */
function isLive(row: VerificationSessionRow): boolean {
  return (
    row.status === 'requires_input' ||
    row.status === 'processing' ||
    row.redactionStatus === 'processing'
  );
}

/**
 * A retrieve: the row reconciled with the provider while it can still move,
 * with the person's credentials while `requires_input`, and — only when asked
 * for, only once `verified` and never after a redaction — the verified data,
 * read live. A provider outage on the reconcile answers the row as stored; a
 * failure reading the data the caller asked for is an error, never a `null`
 * that would read as "nothing verified".
 */
export async function retrieveVerificationSession(
  row: VerificationSessionRow,
  include: { readonly verifiedOutputs: boolean; readonly dob: boolean; readonly idNumber: boolean },
): Promise<{ row: VerificationSessionRow; live: VerificationSessionLive }> {
  let current = row;
  let live: VerificationSessionLive = {};
  if (isLive(row)) {
    try {
      const provider = storedProvider(row);
      const snapshot = await provider.getVerificationSession(row.providerObjectId);
      const outcome = await applyVerificationSnapshot(row, snapshot);
      if (outcome.kind !== 'irreconcilable') current = outcome.row;
      live = { clientSecret: snapshot.clientSecret, url: snapshot.url };
    } catch {
      current = row;
    }
  }
  if (include.verifiedOutputs) {
    const readable = current.status === 'verified' && current.redactionStatus === null;
    const verifiedOutputs = readable
      ? await atProvider(modeOf(current.livemode), () =>
          storedProvider(current).getVerifiedOutputs(current.providerObjectId, {
            dob: include.dob,
            idNumber: include.idNumber,
          }),
        )
      : null;
    live = { ...live, verifiedOutputs };
  }
  return { row: current, live };
}

/**
 * Change `type` / `options` (at the provider first) and metadata — only while
 * `requires_input` and not redacted.
 */
export async function updateVerificationSession(
  row: VerificationSessionRow,
  input: {
    readonly type?: VerificationSessionType | undefined;
    readonly options?: VerificationOptionsParams | undefined;
    readonly metadata?: MetadataPatch | undefined;
  },
): Promise<VerificationSessionRow | 'limit_exceeded'> {
  if (row.status !== 'requires_input' || row.redactionStatus !== null) {
    throw new VerificationSessionStateError(row, 'updated');
  }
  const type = input.type ?? row.type;
  const reconfigures = input.type !== undefined || input.options !== undefined;
  const options = reconfigures
    ? normalizeVerificationOptions(
        type,
        input.options ??
          (type === row.type && row.options.document ? toParams(row.options) : undefined),
      )
    : undefined;
  if (options !== undefined) {
    const mode = modeOf(row.livemode);
    const provider = storedProvider(row);
    await atProvider(mode, () =>
      provider.updateVerificationSession({
        providerObjectId: row.providerObjectId,
        type,
        options: toProviderOptions(options),
        // The row's version: a retry of this change replays it, a later change is a new one.
        idempotencyKey: `vsupd:${row.publicId}:${row.updatedAt.getTime()}`,
      }),
    );
  }
  const updated = await updateVerificationSessionConfig(getDb(), row.id, {
    ...(reconfigures ? { type, options } : {}),
    metadata: input.metadata,
  });
  if (updated === 'stale') {
    const current = (await findVerificationSessionById(getDb(), row.id)) ?? row;
    throw new VerificationSessionStateError(current, 'updated');
  }
  return updated;
}

/** The stored document options as a request would spell them (to keep them across a metadata-free edit). */
function toParams(options: VerificationOptions): VerificationOptionsParams {
  const document = options.document;
  if (document === undefined) return {};
  return {
    document: {
      ...(document.allowed_types !== null ? { allowed_types: document.allowed_types } : {}),
      ...(document.require_id_number !== null
        ? { require_id_number: document.require_id_number }
        : {}),
      ...(document.require_live_capture !== null
        ? { require_live_capture: document.require_live_capture }
        : {}),
      ...(document.require_matching_selfie !== null
        ? { require_matching_selfie: document.require_matching_selfie }
        : {}),
    },
  };
}

/** Cancel — only while `requires_input` and not redacted; at the provider, then here. */
export async function cancelVerificationSession(
  row: VerificationSessionRow,
): Promise<VerificationSessionRow> {
  if (row.status !== 'requires_input' || row.redactionStatus !== null) {
    throw new VerificationSessionStateError(row, 'canceled');
  }
  const provider = storedProvider(row);
  const snapshot = await atProvider(modeOf(row.livemode), () =>
    provider.cancelVerificationSession({
      providerObjectId: row.providerObjectId,
      idempotencyKey: `vscancel:${row.publicId}`,
    }),
  );
  return settle(row, snapshot);
}

/**
 * Redact — erase what was collected. Refused while `processing` (the provider
 * is still reading what it would erase); a session already under redaction
 * answers as it stands.
 */
export async function redactVerificationSession(
  row: VerificationSessionRow,
): Promise<VerificationSessionRow> {
  if (row.redactionStatus !== null) return row;
  if (row.status === 'processing') throw new VerificationSessionStateError(row, 'redacted');
  const provider = storedProvider(row);
  const snapshot = await atProvider(modeOf(row.livemode), () =>
    provider.redactVerificationSession({
      providerObjectId: row.providerObjectId,
      idempotencyKey: `vsredact:${row.publicId}`,
    }),
  );
  // The provider answered: it holds a redaction job now, whatever it reports
  // as the job's status (`validated` reads as none). Orbit's own erasure does
  // not wait for it.
  return settle(row, { ...snapshot, redaction: snapshot.redaction ?? 'processing' });
}

async function settle(
  row: VerificationSessionRow,
  snapshot: ProviderVerificationSession,
): Promise<VerificationSessionRow> {
  const outcome = await applyVerificationSnapshot(row, snapshot);
  if (outcome.kind === 'irreconcilable') {
    throw new ProviderError({
      provider: row.provider,
      stage: 'identity',
      message: outcome.error,
      retryable: false,
    });
  }
  return outcome.row;
}
