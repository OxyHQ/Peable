/**
 * SetupIntents (`seti_…`, ADR 0016, ADR 0019) — saving a card for later.
 *
 * Row first, provider second (`seti:<public id>` is the provider idempotency
 * key, so a retry finishes an interrupted create rather than making a second
 * one). Every status write is a compare-and-swap and commits with its
 * `setup_intent.*` event; a success also registers the `pm_…` and emits
 * `payment_method.attached` in that same transaction.
 */
import type {
  SetupIntentCancellationReason,
  SetupIntentStatus,
  SetupIntentUsage,
} from '@peable.to/shared-types';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { CustomerRow } from '../../db/customers/customerRepository';
import {
  findSetupIntentById,
  insertSetupIntent,
  linkSetupIntentObject,
  updateSetupIntentState,
  type SetupIntentRow,
} from '../../db/customers/setupIntentRepository';
import { getDb } from '../../db/postgres';
import { clientSecretFor, newId } from '../../lib/ids';
import { toSetupIntentDTO } from '../../lib/serialize';
import { recordCustomerObjectEvent, type CustomerObjectEventType } from '../intentTransition';
import { followSetupIntentForCheckout } from '../checkout/completion';
import { kickWebhookOutbox } from '../webhookOutbox';
import { toLastPaymentError } from '../intentReconciliation';
import { selectCardProvider, selectStoredProvider } from '../providers/environmentGuard';
import {
  isSetupHoldingProvider,
  type ProviderSetupResult,
  type SetupHoldingProvider,
} from '../providers/provider';
import { ensureProviderCustomer } from './providerCustomer';
import { registerProviderPaymentMethod } from './paymentMethodService';

export class SetupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupUnavailableError';
  }
}

/** Legal SetupIntent moves — Stripe's: terminal `succeeded` and `canceled` go nowhere. */
const ALLOWED: Record<SetupIntentStatus, readonly SetupIntentStatus[]> = {
  requires_payment_method: [
    'requires_confirmation',
    'requires_action',
    'processing',
    'succeeded',
    'canceled',
  ],
  requires_confirmation: [
    'requires_payment_method',
    'requires_action',
    'processing',
    'succeeded',
    'canceled',
  ],
  requires_action: ['requires_payment_method', 'processing', 'succeeded', 'canceled'],
  processing: ['requires_payment_method', 'succeeded', 'canceled'],
  succeeded: [],
  canceled: [],
};

export function isValidSetupTransition(from: SetupIntentStatus, to: SetupIntentStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Every status, from the table — pinned against the contract's list in the tests. */
export const SETUP_STATUSES_FROM_TABLE = Object.keys(ALLOWED) as SetupIntentStatus[];

/** Which event a SetupIntent that has just moved tells its merchant about. */
function setupEventFor(row: SetupIntentRow): CustomerObjectEventType | null {
  switch (row.status) {
    case 'requires_payment_method':
      return row.lastSetupError !== null ? 'setup_intent.setup_failed' : null;
    case 'requires_action':
      return 'setup_intent.requires_action';
    case 'succeeded':
      return 'setup_intent.succeeded';
    case 'canceled':
      return 'setup_intent.canceled';
    case 'requires_confirmation':
    case 'processing':
      return null;
  }
}

function setupProviderFor(row: SetupIntentRow): SetupHoldingProvider {
  const provider = selectStoredProvider(row.provider, row.livemode);
  if (!provider || !isSetupHoldingProvider(provider)) {
    throw new SetupUnavailableError(
      `the card rail is not configured for ${row.livemode ? 'live' : 'test'} mode on this deployment`,
    );
  }
  return provider;
}

/**
 * Create a SetupIntent for a LIVE customer. Card only, on the provider of the
 * merchant's own mode (ADR 0017).
 *
 * @throws {SetupUnavailableError} when this mode has no card rail (a 503).
 */
export async function createSetupIntent(
  merchant: MerchantRow,
  customer: CustomerRow,
  input: {
    readonly usage: SetupIntentUsage;
    readonly description: string | null;
    readonly metadata: Record<string, string>;
  },
): Promise<{ row: SetupIntentRow; clientAction?: ProviderSetupResult['clientAction'] }> {
  const provider = selectCardProvider(merchant.environment);
  if (!provider || !isSetupHoldingProvider(provider)) {
    throw new SetupUnavailableError(
      `the card rail is not configured for ${merchant.environment === 'production' ? 'live' : 'test'} mode on this deployment`,
    );
  }
  const publicId = newId('seti');
  const db = getDb();
  const inserted = await db.transaction(async (tx) => {
    const row = await insertSetupIntent(tx, {
      publicId,
      merchantId: merchant.id,
      customerId: customer.id,
      usage: input.usage,
      clientSecret: clientSecretFor(publicId),
      description: input.description,
      metadata: input.metadata,
      provider: provider.id,
    });
    await recordCustomerObjectEvent(tx, merchant.id, 'setup_intent.created', toSetupIntentDTO(row));
    return row;
  });
  kickWebhookOutbox();
  const result = await attachProviderSetup(inserted, customer, provider);
  const row = (await findSetupIntentById(db, inserted.id)) ?? inserted;
  return { row, ...(result.clientAction ? { clientAction: result.clientAction } : {}) };
}

async function attachProviderSetup(
  row: SetupIntentRow,
  customer: CustomerRow,
  provider: SetupHoldingProvider,
): Promise<ProviderSetupResult> {
  const customerObjectId = await ensureProviderCustomer(customer, provider);
  const result = await provider.createSetup({
    setupIntentId: row.publicId,
    customerObjectId,
    usage: row.usage,
    idempotencyKey: `seti:${row.publicId}`,
  });
  await linkSetupIntentObject(getDb(), row.id, result.providerObjectId);
  return result;
}

export type SetupApplyOutcome =
  | { readonly kind: 'applied'; readonly row: SetupIntentRow }
  | { readonly kind: 'agreed'; readonly row: SetupIntentRow }
  | { readonly kind: 'irreconcilable'; readonly error: string };

/**
 * Move a SetupIntent to what the provider says — the ONE place a provider
 * SetupIntent becomes a transition (the drain, a retrieve, a cancel).
 *
 * A success reads the provider's payment method FIRST (a network call, outside
 * the transaction), then registers the `pm_…`, moves the SetupIntent and emits
 * both events in one commit.
 */
export async function applySetupResult(
  row: SetupIntentRow,
  result: ProviderSetupResult,
  options: { readonly cancellationReason?: SetupIntentCancellationReason } = {},
): Promise<SetupApplyOutcome> {
  const failed = result.status === 'requires_payment_method' && result.lastSetupError !== undefined;
  if (result.status === row.status && !failed) return { kind: 'agreed', row };
  if (result.status !== row.status && !isValidSetupTransition(row.status, result.status)) {
    return {
      kind: 'irreconcilable',
      error: `a setup intent that is '${row.status}' cannot become '${result.status}'`,
    };
  }
  if (row.status === 'requires_payment_method' && failed && row.lastSetupError !== null) {
    // A failure already recorded is not news twice.
    return { kind: 'agreed', row };
  }

  const provider = setupProviderFor(row);
  const snapshot =
    result.status === 'succeeded'
      ? result.paymentMethodObjectId === undefined
        ? null
        : await provider.getPaymentMethod(result.paymentMethodObjectId)
      : null;
  if (result.status === 'succeeded' && snapshot === null) {
    return { kind: 'irreconcilable', error: 'the provider reports success and no payment method' };
  }

  const moved = await getDb()
    .transaction(async (tx) => {
      const registered =
        snapshot === null
          ? null
          : await registerProviderPaymentMethod(tx, {
              merchantId: row.merchantId,
              customerId: row.customerId,
              provider: provider.id,
              snapshot,
            });
      const change = await updateSetupIntentState(tx, row.id, {
        from: row.status,
        status: result.status,
        ...(failed && result.lastSetupError
          ? { lastSetupError: toLastPaymentError(result.lastSetupError) }
          : {}),
        ...(result.status === 'canceled' && options.cancellationReason !== undefined
          ? { cancellationReason: options.cancellationReason }
          : {}),
        ...(registered ? { paymentMethodId: registered.row.id } : {}),
      });
      if (change.kind !== 'updated') {
        // The row moved underneath: undo the registration with the rest.
        throw new StaleSetupIntent(change.kind === 'stale' ? change.current : null);
      }
      // A setup checkout session completes (or expires) with its SetupIntent.
      await followSetupIntentForCheckout(tx, change.row);
      const eventType = setupEventFor(change.row);
      if (eventType !== null) {
        await recordCustomerObjectEvent(
          tx,
          row.merchantId,
          eventType as Extract<CustomerObjectEventType, `setup_intent.${string}`>,
          toSetupIntentDTO(change.row),
        );
      }
      return change.row;
    })
    .catch((error: unknown) => {
      if (error instanceof StaleSetupIntent) return null;
      throw error;
    });
  if (moved === null) {
    const current = (await findSetupIntentById(getDb(), row.id)) ?? row;
    return { kind: 'agreed', row: current };
  }
  kickWebhookOutbox();
  return { kind: 'applied', row: moved };
}

class StaleSetupIntent extends Error {
  constructor(readonly current: SetupIntentStatus | null) {
    super('the setup intent moved underneath the update');
  }
}

/**
 * Re-read a SetupIntent at the provider and apply it. Never throws for a
 * provider outage — a retrieve answers what the row says.
 */
export async function reconcileSetupIntent(row: SetupIntentRow): Promise<SetupIntentRow> {
  if (row.providerObjectId === null || row.status === 'succeeded' || row.status === 'canceled') {
    return row;
  }
  try {
    const provider = setupProviderFor(row);
    const result = await provider.getSetup(row.providerObjectId);
    const outcome = await applySetupResult(row, result);
    return outcome.kind === 'irreconcilable' ? row : outcome.row;
  } catch {
    return row;
  }
}

/**
 * Cancel a SetupIntent — at the provider first, then here. A SetupIntent that
 * already succeeded or was cancelled answers `unexpected_state`.
 */
export async function cancelSetupIntent(
  row: SetupIntentRow,
  cancellationReason: SetupIntentCancellationReason | undefined,
): Promise<SetupApplyOutcome | { readonly kind: 'unexpected_state' }> {
  if (row.status === 'succeeded' || row.status === 'canceled' || row.status === 'processing') {
    return { kind: 'unexpected_state' };
  }
  if (row.providerObjectId === null) {
    // Never reached the provider: there is nothing there to cancel.
    return applySetupResult(
      row,
      { providerObjectId: '', status: 'canceled' },
      cancellationReason !== undefined ? { cancellationReason } : {},
    );
  }
  const provider = setupProviderFor(row);
  const result = await provider.cancelSetup({
    providerObjectId: row.providerObjectId,
    idempotencyKey: `seticancel:${row.publicId}`,
    ...(cancellationReason !== undefined ? { cancellationReason } : {}),
  });
  return applySetupResult(
    row,
    result,
    cancellationReason !== undefined ? { cancellationReason } : {},
  );
}

/** The payer's confirmation credential, read from the provider — never stored. */
export async function setupClientAction(
  row: SetupIntentRow,
): Promise<ProviderSetupResult['clientAction'] | undefined> {
  if (row.providerObjectId === null) return undefined;
  const provider = setupProviderFor(row);
  return (await provider.getSetup(row.providerObjectId)).clientAction;
}
