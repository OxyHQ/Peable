/**
 * Settling a seller out of a funded payment, and taking it back.
 *
 * Two rules govern everything here and neither is negotiable:
 *
 * 1. **The amount comes from the merchant.** This gateway does not compute a
 *    marketplace's split and must never learn its fee schedule. It records that
 *    a stated amount was moved.
 * 2. **The payment must be SETTLED first.** A transfer against a payment that
 *    has not been captured draws on money that is not there, and the provider
 *    answers `balance_insufficient` — intermittently, because whether it fails
 *    depends on the platform's balance from other traffic. Refusing here makes
 *    it deterministic.
 */
import type { CurrencyCode, MerchantEnvironment } from "@peable.to/shared-types";
import {
  applyTransferReversal,
  findTransferByExternalRef,
  insertTransfer,
  markTransferFailed,
  markTransferPaid,
  type TransferRow,
} from "../../db/transfers/transferRepository";
import type { ConnectedAccountRow } from "../../db/accounts/connectedAccountRepository";
import type { PaymentIntentRow } from "../../db/payments/paymentIntentRepository";
import { getDb } from "../../db/postgres";
import { newId } from "../../lib/ids";
import { assertEnvironmentMatchesProvider } from "../providers/environmentGuard";
import { isSettlingProvider, ProviderError, type SettlingPaymentProvider } from "../providers/provider";
import { redactProviderMessage } from "../providers/redact";
import { resolveProvider } from "../providers/registry";

/** The rail cannot settle sub-merchants — a true statement about the chain rail. */
export class TransfersUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransfersUnavailableError";
  }
}

/** The payment is not in a state a transfer can draw on. */
export class PaymentNotSettledError extends Error {
  constructor(status: string) {
    super(`a transfer needs a settled payment; this one is '${status}'`);
    this.name = "PaymentNotSettledError";
  }
}

/** The seller cannot receive money yet. */
export class AccountNotPayableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountNotPayableError";
  }
}

function requireSettlingProvider(id: TransferRow["provider"]): SettlingPaymentProvider {
  const provider = resolveProvider(id);
  if (!provider) {
    throw new TransfersUnavailableError(`the ${id} rail is not configured on this deployment`);
  }
  if (!isSettlingProvider(provider)) {
    throw new TransfersUnavailableError(`the ${id} rail cannot settle sub-merchants`);
  }
  return provider;
}

export interface CreateTransferInput {
  readonly merchantId: string;
  /** The asking credential's environment — checked against the provider's mode. */
  readonly environment: MerchantEnvironment;
  readonly intent: PaymentIntentRow;
  readonly account: ConnectedAccountRow;
  /** The MERCHANT's own id for what this settles. The idempotency. */
  readonly externalRef: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
}

export interface CreateTransferResult {
  readonly transfer: TransferRow;
  /** `false` when this order had already been settled. */
  readonly created: boolean;
}

/**
 * Settle one seller.
 *
 * Row first, provider second — the same two-step as a payment intent, and for
 * the same reason: a crash between them leaves a row that says an attempt was
 * made, which recovery can finish with the same idempotency key. The reverse
 * leaves a seller paid with nothing here recording it.
 */
export async function createTransfer(
  input: CreateTransferInput,
): Promise<CreateTransferResult> {
  // FIRST, for the same reason the refund path checks it first: this is an
  // authorization decision, and a wrong-mode credential must not be able to
  // probe a payment's state or a seller's readiness by reading which refusal
  // it gets back.
  assertEnvironmentMatchesProvider(input.environment);
  if (input.intent.status !== "settled") {
    throw new PaymentNotSettledError(input.intent.status);
  }
  if (!input.intent.provider || !input.intent.providerObjectId) {
    // A settled payment with no provider object is a FairCoin payment, whose
    // money never passed through this gateway and which it therefore cannot
    // move. Not an error state — a different rail.
    throw new TransfersUnavailableError(
      "this payment did not settle through a provider this gateway can transfer from",
    );
  }
  if (input.account.transfersCapability !== "active" || !input.account.payoutsEnabled) {
    throw new AccountNotPayableError(
      "the seller's account cannot receive settlements yet",
    );
  }
  if (input.currency !== input.intent.currency) {
    // A transfer in a different currency from the charge is an FX conversion
    // this gateway does not perform, and the provider would either refuse it or
    // convert at a rate nothing here recorded.
    throw new TransfersUnavailableError(
      `a transfer must settle in the payment's currency (${input.intent.currency})`,
    );
  }

  const provider = requireSettlingProvider(input.intent.provider);
  const db = getDb();

  const inserted = await insertTransfer(db, {
    publicId: newId("tr"),
    merchantId: input.merchantId,
    paymentIntentId: input.intent.id,
    connectedAccountId: input.account.id,
    externalRef: input.externalRef,
    amount: input.amount,
    currency: input.currency,
    provider: provider.id,
    sourcePaymentObjectId: input.intent.providerObjectId,
  });

  if (!inserted) {
    const existing = await findTransferByExternalRef(db, input.merchantId, input.externalRef);
    if (!existing) {
      throw new Error(`transfer for ${input.externalRef} neither inserted nor found`);
    }
    return { transfer: existing, created: false };
  }

  try {
    const result = await provider.createTransfer({
      intentId: input.intent.publicId,
      transferId: inserted.publicId,
      sourcePaymentObjectId: input.intent.providerObjectId,
      destinationAccountId: input.account.providerAccountId,
      amount: { amount: input.amount, currency: input.currency },
      // Every movement of one checkout, tied together at the provider by the
      // payment's own public id — which is what `createPayment` set as the
      // transfer group, so a reconciliation can list them without this gateway.
      groupRef: input.intent.publicId,
      idempotencyKey: `tr:${inserted.publicId}`,
      metadata: { peable_transfer_id: inserted.publicId },
    });
    const paid = await markTransferPaid(db, inserted.id, result.providerObjectId);
    return { transfer: paid ?? inserted, created: true };
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      // A PERMANENT refusal is recorded and reported. A retryable one is left
      // as `pending` and rethrown: marking it failed would tell the merchant a
      // settlement is dead when the next attempt would have worked.
      const failed = await markTransferFailed(
        db,
        inserted.id,
        redactProviderMessage(error.message),
      );
      return { transfer: failed ?? inserted, created: true };
    }
    throw error;
  }
}

export interface ReverseTransferInput {
  /** The asking credential's environment — checked against the provider's mode. */
  readonly environment: MerchantEnvironment;
  readonly transfer: TransferRow;
  /** This leg's amount, in the transfer's currency. */
  readonly amount: string;
}

/**
 * Take some or all of a settlement back.
 *
 * The provider reports a CUMULATIVE reversed total and that is what is stored —
 * never this leg's amount. A caller adding legs up itself gets the second
 * partial reversal wrong whenever it has not seen the first, and the two are
 * indistinguishable afterwards.
 */
export async function reverseTransfer(input: ReverseTransferInput): Promise<TransferRow> {
  const { transfer } = input;
  if (!transfer.providerObjectId) {
    throw new TransfersUnavailableError(
      "this transfer never reached the provider; there is nothing to reverse",
    );
  }
  assertEnvironmentMatchesProvider(input.environment);
  const provider = requireSettlingProvider(transfer.provider);

  const result = await provider.reverseTransfer({
    transferId: transfer.publicId,
    transferObjectId: transfer.providerObjectId,
    amount: { amount: input.amount, currency: transfer.currency },
    // The LEG is in the key, not just the transfer: two partial reversals of
    // one transfer are two distinct operations, and a key naming only the
    // transfer would make the second a replay of the first — silently
    // returning the first reversal and leaving the money unreturned.
    idempotencyKey: `trr:${transfer.publicId}:${input.amount}`,
    metadata: { peable_transfer_id: transfer.publicId },
  });

  const updated = await applyTransferReversal(getDb(), transfer.id, result.totalReversed);
  // `null` means the stored total was already at least this one — an
  // out-of-order provider answer. The transfer as we have it is still correct.
  return updated ?? transfer;
}
