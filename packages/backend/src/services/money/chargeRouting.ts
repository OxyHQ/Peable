/**
 * Which charge a card payment is, decided ONCE at create (ADR 0015 §2).
 *
 * | Merchant | Charge | Merchant of record | Fee |
 * |---|---|---|---|
 * | Oxy first-party | platform charge | Oxy (the platform) | none |
 * | has its own onboarded account | destination charge, `on_behalf_of` its account | the merchant | its fee schedule |
 * | a marketplace with no own account | platform charge, separate transfers to sellers | the platform (ADR 0009, open) | none |
 * | a platform naming `transfer_data` / `on_behalf_of` | destination charge to that seller | the seller when `on_behalf_of` | `application_fee_amount` it names |
 *
 * The answer is stored on the intent and replayed from the row whenever the
 * provider object is (re)created, so a retry never sends a different charge.
 *
 * ## The release gate
 *
 * A live destination charge for a merchant that is NOT one of Oxy's own
 * products is refused unless `ORBIT_THIRD_PARTY_LIVE_PAYMENTS=true` — ADR 0015's
 * legal gate in code. Test mode is never gated.
 */
import type { CurrencyCode } from '@peable.to/shared-types';
import { config } from '../../config';
import {
  findAccountByPublicId,
  findAccountForOnboarding,
  findMerchantAccount,
  hasCardHalf,
  type CardConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import { findFeeSchedule } from '../../db/money/feeScheduleRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import type { DatabaseOrTransaction } from '../../db/postgres';
import { getDb } from '../../db/postgres';

/** The third-party live gate is closed for this merchant (ADR 0015 release gate). 403. */
export class ThirdPartyLiveGateError extends Error {
  constructor(what: string) {
    super(
      `${what} for a merchant that is not an Oxy product is not enabled in live mode on this deployment (ADR 0015 release gate); test mode is available`,
    );
    this.name = 'ThirdPartyLiveGateError';
  }
}

/** A destination-charge parameter that cannot be honoured — a 400/409 naming it. */
export class ChargeRoutingError extends Error {
  constructor(
    message: string,
    readonly param: string,
    readonly status: 400 | 409 = 400,
    readonly code:
      | 'parameter_invalid'
      | 'resource_missing'
      | 'account_not_ready' = 'parameter_invalid',
  ) {
    super(message);
    this.name = 'ChargeRoutingError';
  }
}

/** Whether live money movement on the new model is open for this merchant. */
export function liveMoneyAllowed(merchant: Pick<MerchantRow, 'livemode' | 'firstParty'>): boolean {
  return !merchant.livemode || merchant.firstParty || config.orbit.thirdPartyLivePayments;
}

/** @throws {ThirdPartyLiveGateError} */
export function assertLiveMoneyAllowed(
  merchant: Pick<MerchantRow, 'livemode' | 'firstParty'>,
  what: string,
): void {
  if (!liveMoneyAllowed(merchant)) throw new ThirdPartyLiveGateError(what);
}

/**
 * Orbit's fee for one card payment: the merchant's schedule for the currency,
 * else the deployment default. `percent` rounds HALF UP in base units, plus the
 * fixed part, never more than the payment itself.
 */
export async function computeApplicationFee(
  db: DatabaseOrTransaction,
  merchantId: string,
  currency: CurrencyCode,
  amount: string,
): Promise<string> {
  const schedule = await findFeeSchedule(db, merchantId, 'card', currency);
  const bps = BigInt(schedule?.percentBps ?? config.orbit.defaultFeePercentBps);
  const fixed = BigInt(schedule?.fixedAmount ?? config.orbit.defaultFeeFixed[currency] ?? '0');
  const gross = BigInt(amount);
  const fee = (gross * bps + 5000n) / 10000n + fixed;
  return (fee > gross ? gross : fee).toString();
}

/** What a create asked for, already parsed (public ids). */
export interface ChargeRoutingRequest {
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly applicationFeeAmount?: string;
  readonly transferData?: { readonly destination: string; readonly amount?: string };
  readonly onBehalfOf?: string;
}

/** The decision, as the intent stores it (INTERNAL account ids). `null` is a platform charge. */
export interface ChargeRouting {
  readonly transferDestinationId: string;
  readonly transferAmount: string | null;
  readonly onBehalfOfId: string | null;
  readonly applicationFeeAmount: string | null;
}

async function requireSellerWithCard(
  merchant: MerchantRow,
  publicId: string,
  param: string,
): Promise<CardConnectedAccountRow> {
  const account = await findAccountByPublicId(getDb(), merchant.id, publicId);
  if (!account) {
    throw new ChargeRoutingError(
      `${param} does not name a connected account of this merchant`,
      param,
      400,
      'resource_missing',
    );
  }
  if (!hasCardHalf(account)) {
    throw new ChargeRoutingError(
      'this connected account has no card account; open one first',
      param,
      409,
      'account_not_ready',
    );
  }
  return account;
}

function assertWithin(amount: string, of: string, param: string): void {
  if (BigInt(amount) > BigInt(of)) {
    throw new ChargeRoutingError(`${param} cannot exceed the payment's amount`, param);
  }
}

/**
 * Decide the charge for a new card payment.
 *
 * @throws {ChargeRoutingError} for a parameter that names nothing this merchant
 *   holds, or an account that cannot take the charge yet.
 * @throws {ThirdPartyLiveGateError} for a live destination charge behind the gate.
 */
export async function decideChargeRouting(
  merchant: MerchantRow,
  request: ChargeRoutingRequest,
): Promise<ChargeRouting | null> {
  const explicit =
    request.applicationFeeAmount !== undefined ||
    request.transferData !== undefined ||
    request.onBehalfOf !== undefined;

  if (explicit) {
    // A platform acting for one of its connected accounts.
    if (request.applicationFeeAmount !== undefined && request.transferData === undefined) {
      throw new ChargeRoutingError(
        'application_fee_amount needs transfer_data.destination',
        'application_fee_amount',
      );
    }
    if (request.transferData === undefined) {
      throw new ChargeRoutingError(
        'on_behalf_of needs transfer_data.destination: the funds go to the merchant of record',
        'transfer_data',
      );
    }
    if (request.applicationFeeAmount !== undefined && request.transferData.amount !== undefined) {
      throw new ChargeRoutingError(
        'use application_fee_amount or transfer_data.amount, not both',
        'transfer_data[amount]',
      );
    }
    const destination = await requireSellerWithCard(
      merchant,
      request.transferData.destination,
      'transfer_data[destination]',
    );
    const onBehalfOf =
      request.onBehalfOf === undefined
        ? null
        : request.onBehalfOf === request.transferData.destination
          ? destination
          : await requireSellerWithCard(merchant, request.onBehalfOf, 'on_behalf_of');
    if (request.applicationFeeAmount !== undefined) {
      assertWithin(request.applicationFeeAmount, request.amount, 'application_fee_amount');
    }
    if (request.transferData.amount !== undefined) {
      assertWithin(request.transferData.amount, request.amount, 'transfer_data[amount]');
    }
    assertLiveMoneyAllowed(merchant, 'a destination charge');
    return {
      transferDestinationId: destination.id,
      transferAmount: request.transferData.amount ?? null,
      onBehalfOfId: onBehalfOf?.id ?? null,
      applicationFeeAmount: request.applicationFeeAmount ?? null,
    };
  }

  // Oxy's own products: a platform charge with Oxy as merchant of record.
  if (merchant.firstParty) return null;

  const own = await findMerchantAccount(getDb(), merchant.id);
  // A marketplace (or a merchant not yet on the account model): the platform
  // charge it always was — ADR 0009's open merchant-of-record decision.
  if (!own) return null;
  if (!hasCardHalf(own) || !own.chargesEnabled) {
    // Falling back to a platform charge would make the platform the merchant of
    // record for a merchant that chose to be its own (ADR 0015) — refused.
    throw new ChargeRoutingError(
      "the merchant's account cannot take payments yet; finish onboarding (POST /v1/account_links)",
      'rail',
      409,
      'account_not_ready',
    );
  }
  assertLiveMoneyAllowed(merchant, 'a destination charge');
  const fee = await computeApplicationFee(getDb(), merchant.id, request.currency, request.amount);
  return {
    transferDestinationId: own.id,
    transferAmount: null,
    onBehalfOfId: own.id,
    // A zero fee is no fee instructed — not a `0` the provider would record.
    applicationFeeAmount: fee === '0' ? null : fee,
  };
}

/**
 * The provider-side routing of a stored intent: its accounts' PROVIDER ids, read
 * from the rows the intent references. What every (re)create of the provider
 * object sends, so a resumed create sends the charge the intent recorded.
 */
export async function providerRoutingFor(intent: PaymentIntentRow): Promise<{
  readonly transferDestination?: string;
  readonly transferAmount?: string;
  readonly onBehalfOf?: string;
  readonly applicationFeeAmount?: string;
}> {
  if (!intent.transferDestinationId) return {};
  const db = getDb();
  const destination = await findAccountForOnboarding(db, intent.transferDestinationId);
  if (!destination?.providerAccountId) {
    throw new Error(`payment ${intent.publicId} names a destination with no provider account`);
  }
  const onBehalfOf = intent.onBehalfOfId
    ? intent.onBehalfOfId === intent.transferDestinationId
      ? destination
      : await findAccountForOnboarding(db, intent.onBehalfOfId)
    : null;
  return {
    transferDestination: destination.providerAccountId,
    ...(intent.transferAmount ? { transferAmount: intent.transferAmount } : {}),
    ...(onBehalfOf?.providerAccountId ? { onBehalfOf: onBehalfOf.providerAccountId } : {}),
    ...(intent.applicationFeeAmount ? { applicationFeeAmount: intent.applicationFeeAmount } : {}),
  };
}
