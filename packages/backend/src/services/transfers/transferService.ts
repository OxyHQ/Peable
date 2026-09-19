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
  sumCommittedTransfers,
  type TransferRow,
} from "../../db/transfers/transferRepository";
import {
  linkProviderCharge,
  lockIntentForUpdate,
} from "../../db/payments/paymentIntentRepository";
import {
  findTransferReversalByExternalRef,
  insertTransferReversal,
  markTransferReversalFailed,
  markTransferReversalSucceeded,
  type TransferReversalRow,
} from "../../db/transfers/transferReversalRepository";
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

/**
 * This payment has no charge behind it that a transfer could draw on.
 *
 * Distinct from `PaymentNotSettledError`, which is about the gateway's own
 * view. This one means the gateway believes the payment settled and the
 * PROVIDER does not report a charge — a disagreement an operator has to look
 * at, not a state a merchant can fix by waiting.
 */
export class TransferSourceUnresolvedError extends Error {
  constructor(intentPublicId: string) {
    super(
      `no captured charge could be resolved for ${intentPublicId}; ` +
        "a transfer must draw on the charge that funded the payment",
    );
    this.name = "TransferSourceUnresolvedError";
  }
}

/**
 * The settlement budget: more was asked for than this payment can still fund.
 */
export class TransferExceedsPaymentError extends Error {
  constructor(requested: string, remaining: string) {
    super(
      `a transfer of ${requested} exceeds the ${remaining} this payment can still settle`,
    );
    this.name = "TransferExceedsPaymentError";
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
 * The CHARGE this payment produced, resolved once and recorded.
 *
 * A transfer's `source_transaction` names a charge; `intent.providerObjectId`
 * is the PAYMENT. Handing the payment's id over is the bug this function
 * exists to make impossible — Stripe answers `No such charge: 'pi_…'`, so the
 * settlement fails at the provider, which reads as an outage.
 *
 * The read is AUTHORITATIVE rather than assumed: it asks the provider for the
 * payment's current state and refuses anything that is not `succeeded`. The
 * gateway's own `settled` status can be right while the money is not there —
 * an event arrived out of order, a test fixture, a manual repair — and a
 * transfer against an uncaptured charge draws on the platform's general
 * balance, which is exactly the "funds from another merchant" failure the
 * budget below also guards.
 *
 * Cached in `payment_intents.provider_charge_id`, so a two-seller cart resolves
 * once rather than once per seller.
 */
async function resolveSourceCharge(
  intent: PaymentIntentRow,
  provider: SettlingPaymentProvider,
): Promise<string> {
  if (intent.providerChargeId) return intent.providerChargeId;
  if (!intent.providerObjectId) throw new TransferSourceUnresolvedError(intent.publicId);

  const current = await provider.getStatus(intent.providerObjectId);
  if (current.status !== "succeeded" || !current.chargeObjectId) {
    throw new TransferSourceUnresolvedError(intent.publicId);
  }
  // Best-effort: `linkProviderCharge` is guarded on the column being NULL, so a
  // concurrent settlement that got there first simply wins and this returns the
  // same id it read from the provider.
  await linkProviderCharge(getDb(), intent.id, provider.id, current.chargeObjectId);
  return current.chargeObjectId;
}

/**
 * Settle one seller.
 *
 * Row first, provider second — the same two-step as a payment intent, and for
 * the same reason: a crash between them leaves a row that says an attempt was
 * made, which recovery can finish with the same idempotency key. The reverse
 * leaves a seller paid with nothing here recording it.
 *
 * ## The budget, and why the insert is inside a transaction
 *
 * A payment funds N transfers and nothing used to bound N. Two settlements of a
 * two-seller cart, or a merchant's own arithmetic slip, could move more out of
 * the platform balance than that payment ever brought in — and the difference
 * comes from the platform's general balance, which is other merchants' money in
 * flight. The budget is `intent.amount` minus everything already committed
 * (`sumCommittedTransfers`), and it is evaluated while holding the INTENT's row
 * lock so two concurrent settlements cannot both read the same remaining figure
 * and both pass.
 *
 * The lock is on the payment rather than on the transfer rows because the first
 * settlement of a payment has no transfer rows to lock.
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

  // The charge, resolved BEFORE the row is written. A payment the provider
  // cannot report a captured charge for is one no transfer should be recorded
  // against: writing the row first would leave a `pending` settlement that
  // every recovery pass retries and that can never succeed.
  const sourceChargeObjectId = await resolveSourceCharge(input.intent, provider);

  /**
   * An existing row for this order is either FINISHED or INTERRUPTED, and the
   * two are answered differently.
   *
   * `provider_object_id` tells them apart: a transfer that reached the provider
   * has one, and one that did not is `pending` with nothing behind it. Handing
   * the pending row back unchanged — which is what used to happen — left a
   * settlement no path ever retried, so the merchant's retry got a 200
   * describing a seller who had not been paid.
   *
   * The budget is NOT re-evaluated when resuming. This row was budgeted when it
   * was written and `sumCommittedTransfers` counts it, so charging it again
   * would refuse every resume with "exceeds what this payment can settle".
   */
  const existing = await findTransferByExternalRef(db, input.merchantId, input.externalRef);
  if (existing && (existing.providerObjectId !== null || existing.status === "failed")) {
    // Finished, one way or the other. History does not change because it was
    // asked about again.
    return { transfer: existing, created: false };
  }

  const inserted =
    existing ??
    (await db.transaction(async (tx) => {
      // The serialization point. Everything between here and the commit is the
      // budget check, and it has to be exclusive per PAYMENT.
      await lockIntentForUpdate(tx, input.intent.id);
      const committed = await sumCommittedTransfers(tx, input.intent.id);
      const remaining = BigInt(input.intent.amount) - BigInt(committed);
      if (BigInt(input.amount) > remaining) {
        // `BigInt`, not `Number`: canonical integer strings are unbounded and a
        // minor-unit currency reaches past `Number.MAX_SAFE_INTEGER`, where the
        // comparison would start rounding — in the direction that lets a
        // transfer through.
        throw new TransferExceedsPaymentError(
          input.amount,
          (remaining > 0n ? remaining : 0n).toString(),
        );
      }
      return insertTransfer(tx, {
        publicId: newId("tr"),
        merchantId: input.merchantId,
        paymentIntentId: input.intent.id,
        connectedAccountId: input.account.id,
        externalRef: input.externalRef,
        amount: input.amount,
        currency: input.currency,
        provider: provider.id,
        sourcePaymentObjectId: sourceChargeObjectId,
      });
    }));

  // `null` only from the insert: a concurrent request won the unique index
  // between the read above and the write. Its row is this order's row, so
  // re-reading is correct rather than merely convenient.
  const row =
    inserted ??
    (await findTransferByExternalRef(db, input.merchantId, input.externalRef));
  if (!row) {
    throw new Error(`transfer for ${input.externalRef} neither inserted nor found`);
  }
  if (row.providerObjectId !== null) return { transfer: row, created: false };

  try {
    const result = await provider.createTransfer({
      intentId: input.intent.publicId,
      transferId: row.publicId,
      sourceChargeObjectId,
      destinationAccountId: input.account.providerAccountId,
      amount: { amount: row.amount, currency: input.currency },
      // Every movement of one checkout, tied together at the provider by the
      // payment's own public id — which is what `createPayment` set as the
      // transfer group, so a reconciliation can list them without this gateway.
      groupRef: input.intent.publicId,
      idempotencyKey: `tr:${row.publicId}`,
      metadata: { peable_transfer_id: row.publicId },
    });
    const paid = await markTransferPaid(db, row.id, result.providerObjectId);
    // `created` is about the SETTLEMENT, not about this request: a resumed row
    // is a settlement this call completed, and a merchant needs to know money
    // moved. `existing` is what distinguishes it from a fresh one.
    return { transfer: paid ?? row, created: true };
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      // A PERMANENT refusal is recorded and reported. A retryable one is left
      // as `pending` and rethrown: marking it failed would tell the merchant a
      // settlement is dead when the next attempt would have worked.
      const failed = await markTransferFailed(
        db,
        row.id,
        redactProviderMessage(error.message),
      );
      return { transfer: failed ?? row, created: true };
    }
    throw error;
  }
}

export interface ReverseTransferInput {
  readonly merchantId: string;
  /** The asking credential's environment — checked against the provider's mode. */
  readonly environment: MerchantEnvironment;
  readonly transfer: TransferRow;
  /**
   * The MERCHANT's own id for THIS reversal — their `Idempotency-Key` header or
   * an explicit `externalRef`. Required, because the amount is not an identity.
   */
  readonly externalRef: string;
  /** This leg's amount, in the transfer's currency. */
  readonly amount: string;
}

export interface ReverseTransferResult {
  readonly transfer: TransferRow;
  readonly reversal: TransferReversalRow;
  /** `false` when this reversal had already been made. */
  readonly created: boolean;
}

/**
 * Take some or all of a settlement back.
 *
 * ## The identity, which is the whole of this function's history
 *
 * The provider idempotency key used to be `trr:<transfer>:<amount>` — the LEG
 * in the key, with a comment explaining that a key naming only the transfer
 * would make a second partial reversal a replay of the first. The comment was
 * right about the failure and wrong about the fix: two DISTINCT reversals of
 * one transfer for the same amount are ordinary (two 500-cent line items
 * refunded separately) and presented the same key, so the provider answered the
 * first reversal's object to the second request. The seller kept 500 that had
 * been taken back, the total never moved, and no row anywhere recorded that a
 * second reversal had been asked for.
 *
 * An amount is not an identity. A `transfer_reversals` row is: the merchant's
 * own reference is the idempotency, the key is derived from the row's
 * `public_id`, and a retry converges on the row rather than on a coincidence of
 * amounts.
 *
 * ## The cumulative total is still the provider's
 *
 * These rows are not summed. `transfers.amount_reversed` holds the PROVIDER's
 * own cumulative figure, which includes reversals this gateway did not make and
 * is what the seller's balance reflects.
 */
export async function reverseTransfer(
  input: ReverseTransferInput,
): Promise<ReverseTransferResult> {
  const { transfer } = input;
  assertEnvironmentMatchesProvider(input.environment);
  if (!transfer.providerObjectId) {
    throw new TransfersUnavailableError(
      "this transfer never reached the provider; there is nothing to reverse",
    );
  }
  const provider = requireSettlingProvider(transfer.provider);
  const db = getDb();

  const inserted = await insertTransferReversal(db, {
    publicId: newId("trr"),
    merchantId: input.merchantId,
    transferId: transfer.id,
    externalRef: input.externalRef,
    amount: input.amount,
    currency: transfer.currency,
    provider: provider.id,
  });

  if (!inserted) {
    const existing = await findTransferReversalByExternalRef(
      db,
      input.merchantId,
      input.externalRef,
    );
    if (!existing) {
      throw new Error(`reversal for ${input.externalRef} neither inserted nor found`);
    }
    // A replay answers the transfer AS STORED, without calling the provider.
    // Re-reversing on a retry is the exact failure this row exists to prevent.
    return { transfer, reversal: existing, created: false };
  }

  let result;
  try {
    result = await provider.reverseTransfer({
      transferId: transfer.publicId,
      transferObjectId: transfer.providerObjectId,
      amount: { amount: input.amount, currency: transfer.currency },
      // Derived from the REVERSAL's own durable id and nothing else. Two
      // reversals are two rows, so they are two keys, whatever their amounts.
      idempotencyKey: `trr:${inserted.publicId}`,
      metadata: {
        peable_transfer_id: transfer.publicId,
        peable_reversal_id: inserted.publicId,
      },
    });
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      // A PERMANENT refusal is recorded. A retryable one stays `pending` and is
      // rethrown: marking it failed would say a seller's money is staying with
      // them when the next attempt would have taken it back.
      const failed = await markTransferReversalFailed(
        db,
        inserted.id,
        redactProviderMessage(error.message),
      );
      return { transfer, reversal: failed ?? inserted, created: true };
    }
    throw error;
  }

  const reversal =
    (await markTransferReversalSucceeded(db, inserted.id, result.providerObjectId)) ?? inserted;
  const updated = await applyTransferReversal(db, transfer.id, result.totalReversed);
  // `null` means the stored total was already at least this one — an
  // out-of-order provider answer. The transfer as we have it is still correct.
  return { transfer: updated ?? transfer, reversal, created: true };
}
