/**
 * How a FairCoin address is handed out in a recipient's Peable wallet (ADR 0021
 * D5, D9 amended 2026-11-06) — the ONE place every payment and every
 * `@username` request gets its address from.
 *
 * **Never reused.** Every address is a FRESH index of the recipient's one
 * cursor (`db/social/receiveCursor.ts`, ONE statement), and an index whose
 * address history already holds is skipped ({@link reserveFreshAddress}). No
 * address is ever handed to a second payment or a second sender, so a late
 * payer can only ever pay the order it was quoted for.
 *
 * **No ceiling.** The recipient's wallet watches exactly the addresses handed
 * out — synced from `GET /v1/social/me/receive_addresses`, actively the recent
 * and funded ones and the rest on a schedule — not a contiguous range from 0,
 * so no index is out of its reach and no recipient runs out.
 *
 * **What bounds the set is a rate per recipient.** A new payment address is
 * handed out only while fewer than {@link MAX_UNPAID_PAYMENT_ADDRESSES} of the
 * recipient's payment addresses of the last {@link UNPAID_WINDOW_SECONDS} are
 * unpaid (`@username` has its own, {@link MAX_FRESH_SOCIAL_ADDRESSES}, in
 * `services/socialReceive.ts`), counted and reserved under a per-recipient
 * advisory lock in the reservation's own transaction, so concurrent confirms
 * cannot both pass it. Past it FairCoin is refused 503
 * `faircoin_capacity_reached` for that recipient and every other method keeps
 * working. Paid addresses never count: a busy recipient is never limited by
 * real payments. Per-payer limits sit in front (`lib/faircoinPayerLimit.ts`,
 * the `@username` limiters).
 */
import { bytesToHex, deriveSocialReceiveAddress, getNetwork } from '@fairco.in/core';
import type { NetworkType } from '@fairco.in/core';
import { getDb } from '../../db/postgres';
import type { DatabaseOrTransaction } from '../../db/postgres';
import {
  countUnpaidAddressesSince,
  lockRecipientPool,
} from '../../db/payments/faircoinAddressPool';
import { reserveNextSocialReceiveIndex } from '../../db/social/receiveCursor';
import { isAddressRecorded } from '../../db/social/receiveAddresses';
import { type AddressUsage, getAddressUsage } from '../explorer';

/**
 * Unpaid payment addresses per recipient per network per
 * {@link UNPAID_WINDOW_SECONDS} before a new FairCoin payment is refused. Far
 * above real abandonment (a quote lives 10 minutes) and the whole of what an
 * attacker opening anonymous checkouts can add to a recipient's watch set.
 */
export const MAX_UNPAID_PAYMENT_ADDRESSES = 500;

/** The window the unpaid count looks back over: a day, a payment's longest life. */
export const UNPAID_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * The recipient cannot be handed a new FairCoin address now: too many of its
 * addresses of the last day went unpaid. FairCoin waits; the card does not.
 */
export class FaircoinCapacityError extends Error {
  constructor() {
    super(
      'Too many FairCoin addresses of this recipient went unpaid in the last day; pay another way or try FairCoin again later',
    );
    this.name = 'FaircoinCapacityError';
  }
}

let maxUnpaid = MAX_UNPAID_PAYMENT_ADDRESSES;

/**
 * Replace the bound (tests: a small one, instead of opening 500 payments);
 * `null` restores {@link MAX_UNPAID_PAYMENT_ADDRESSES}. Answers the previous one.
 */
export function useMaxUnpaidAddresses(next: number | null): number {
  const previous = maxUnpaid;
  maxUnpaid = next ?? MAX_UNPAID_PAYMENT_ADDRESSES;
  return previous;
}

type AddressUsageReader = (address: string, network: NetworkType) => Promise<AddressUsage>;
let usageReader: AddressUsageReader = getAddressUsage;

/**
 * Replace the chain read (tests: a fixed answer instead of the Explorer);
 * `null` restores the Explorer. Answers the previous reader.
 */
export function useAddressUsageReader(next: AddressUsageReader | null): AddressUsageReader {
  const previous = usageReader;
  usageReader = next ?? getAddressUsage;
  return previous;
}

/** What the chain says about an address, through the current reader (the Explorer, or a test's). */
export function addressUsage(address: string, network: NetworkType): Promise<AddressUsage> {
  return usageReader(address, network);
}

/** One output's reservation, decided as far as it can be before the payment's transaction. */
export interface PlannedAddress {
  readonly recipientAccountId: string;
  readonly network: NetworkType;
  readonly identityPublicKey: Uint8Array;
}

export interface ReservedAddress {
  readonly recipientAccountId: string;
  readonly address: string;
  readonly derivationIndex: number;
  /** The key the address derives from, lowercase hex — recorded beside it (ADR 0002). */
  readonly identityPublicKey: string;
}

/** How many indices one reservation may skip before it gives up (history only ever holds a few). */
const MAX_SKIPPED_INDICES = 64;

/**
 * Reserve the next index of the recipient's cursor whose address was never
 * handed out, and derive it. The cursor statement is unchanged — ONE
 * statement, the two-consecutive-reservation invariant — and runs as often as
 * an index's address turns out to be recorded already: possible only where
 * history left a cursor behind an address it derived (migration 0009 deleted
 * keyless cursors whose attributions stayed). Skipping an index costs nothing:
 * the wallet watches what was handed out, not a range.
 *
 * The caller's transaction must also write the address's own row (the output,
 * or the attribution) before it commits: the cursor row's lock, held until
 * then, is what orders the sync (`db/social/receiveAddresses.ts`).
 */
export async function reserveFreshAddress(
  tx: DatabaseOrTransaction,
  recipientAccountId: string,
  network: NetworkType,
  identityPublicKey: Uint8Array,
): Promise<ReservedAddress> {
  const keyHex = bytesToHex(identityPublicKey);
  const params = getNetwork(network);
  for (let attempt = 0; attempt <= MAX_SKIPPED_INDICES; attempt += 1) {
    const index = await reserveNextSocialReceiveIndex(tx, recipientAccountId, network, keyHex);
    const address = deriveSocialReceiveAddress(identityPublicKey, index, params);
    if (!(await isAddressRecorded(tx, address, network))) {
      return { recipientAccountId, address, derivationIndex: index, identityPublicKey: keyHex };
    }
  }
  throw new Error(
    `the receive cursor of ${recipientAccountId} on ${network} kept deriving addresses already handed out`,
  );
}

/**
 * Reserve every planned address in the payment's own transaction: the
 * recipients are locked in one order (no two payments can wait on each
 * other's), each one's unpaid count is checked — this payment's own outputs
 * included — and a fresh index is reserved. A rolled-back payment rolls its
 * indices back with it, so no index is spent on a payment that never existed.
 *
 * @throws {FaircoinCapacityError} a recipient already has
 *   {@link MAX_UNPAID_PAYMENT_ADDRESSES} unpaid addresses of the last day.
 */
export async function reservePlannedAddresses(
  tx: DatabaseOrTransaction,
  plans: readonly PlannedAddress[],
): Promise<ReservedAddress[]> {
  const pools = [...new Set(plans.map((plan) => `${plan.network}\u0000${plan.recipientAccountId}`))]
    .sort()
    .map((key) => {
      const [network, recipientAccountId] = key.split('\u0000') as [NetworkType, string];
      return { key, network, recipientAccountId };
    });
  const unpaid = new Map<string, number>();
  for (const pool of pools) {
    await lockRecipientPool(tx, pool.recipientAccountId, pool.network);
    unpaid.set(
      pool.key,
      await countUnpaidAddressesSince(
        tx,
        pool.recipientAccountId,
        pool.network,
        UNPAID_WINDOW_SECONDS,
      ),
    );
  }

  const reserved: ReservedAddress[] = [];
  for (const plan of plans) {
    const key = `${plan.network}\u0000${plan.recipientAccountId}`;
    const count = unpaid.get(key) ?? 0;
    if (count >= maxUnpaid) throw new FaircoinCapacityError();
    unpaid.set(key, count + 1);
    reserved.push(
      await reserveFreshAddress(tx, plan.recipientAccountId, plan.network, plan.identityPublicKey),
    );
  }
  return reserved;
}

/**
 * Whether a new FairCoin payment to the recipient could get an address now —
 * the order page's answer (`temporarily_unavailable` when not). The confirm
 * decides for certain, under the lock.
 */
export async function recipientHasAddressRoom(
  recipientAccountId: string,
  network: NetworkType,
): Promise<boolean> {
  const unpaidNow = await countUnpaidAddressesSince(
    getDb(),
    recipientAccountId,
    network,
    UNPAID_WINDOW_SECONDS,
  );
  return unpaidNow < maxUnpaid;
}
