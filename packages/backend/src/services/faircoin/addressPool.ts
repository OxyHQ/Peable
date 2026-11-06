/**
 * The bound on a recipient's FairCoin tree (ADR 0021 D9) — the ONE place that
 * decides whether a payment gets an address the recipient already owns or a
 * fresh index from its cursor.
 *
 * Every FairCoin payment reserves an address in the RECIPIENT's Peable wallet
 * (ADR 0021 D5), and its wallet scans every index up to the highest reserved.
 * Before this, every confirm minted: anyone able to open a checkout could push
 * a stranger's cursor up without limit and saturate the wallet that scans it.
 * Two rules make the growth a function of real payments instead:
 *
 *  1. **Recycle before minting.** An address held by a payment that was
 *     CANCELLED at least {@link RECYCLE_QUARANTINE_SECONDS} ago, that still
 *     derives from the recipient's current key, and that the chain shows never
 *     received anything (`getAddressUsage` → `unused`) is handed to the next
 *     payment — lowest index first. An address the chain shows used, or that
 *     no longer derives from the key, is retired and never offered again.
 *  2. **Cap what is open.** A fresh index is minted only while fewer than
 *     {@link MAX_OPEN_ADDRESSES} of the recipient's addresses are open (being
 *     paid, payable, or cancelled within the quarantine). At the cap, FairCoin
 *     on that order is refused with `faircoin_capacity_reached` and every
 *     other method keeps working — nothing here can turn a card off.
 *
 * So the recipient's tree holds at most {@link MAX_OPEN_ADDRESSES} addresses
 * nobody paid, plus one per address something was actually sent to: a real
 * payment, or coins an attacker spent to dirty it. The count and the mint are
 * one decision under a per-recipient advisory lock held by the payment's own
 * transaction, so concurrent confirms cannot both pass the cap. The mint itself
 * is unchanged: one statement on the cursor (`db/social/receiveCursor.ts`).
 *
 * `@username` addresses (`routes/social.ts`) are not payments and are not
 * counted here: a sender asking again for a recipient it has not paid yet is
 * handed its previous address (`reuseUnpaidSocialAddress`), so each sender
 * holds at most one unpaid address per recipient.
 */
import { bytesToHex, deriveSocialReceiveAddress, getNetwork } from '@fairco.in/core';
import type { NetworkType } from '@fairco.in/core';
import { getDb } from '../../db/postgres';
import type { DatabaseOrTransaction } from '../../db/postgres';
import {
  claimRecycleCandidate,
  countOpenAddresses,
  listRecycleCandidates,
  lockRecipientPool,
  type RecycleCandidate,
  retireRecycleCandidate,
} from '../../db/payments/faircoinAddressPool';
import { reserveNextSocialReceiveIndex } from '../../db/social/receiveCursor';
import { type AddressUsage, getAddressUsage } from '../explorer';

/**
 * Open addresses per recipient per network before a new FairCoin payment is
 * refused. Far above any real concurrency (a quote lives 10 minutes; an
 * abandoned one is held for the quarantine after it) and far below what
 * troubles a wallet's scan — the finding that motivated this measured a frozen
 * wallet past 150 000 addresses.
 */
export const MAX_OPEN_ADDRESSES = 500;

/**
 * How long after its payment is cancelled an address stays out of the pool: a
 * payer who scanned a quote and pays a little late still pays an address no
 * other order holds. An hour is six times a quote's life.
 */
export const RECYCLE_QUARANTINE_SECONDS = 60 * 60;

/** Candidates read per reservation; a key check is local and cheap. */
const CANDIDATE_BATCH = 20;
/** Explorer reads per reservation: a confirm must not wait on many. */
const MAX_CHAIN_CHECKS = 3;

/** The recipient has {@link MAX_OPEN_ADDRESSES} open: FairCoin waits, the card does not. */
export class FaircoinCapacityError extends Error {
  constructor() {
    super(
      'Too many FairCoin payments to this recipient are waiting to be paid right now; pay another way or try FairCoin again shortly',
    );
    this.name = 'FaircoinCapacityError';
  }
}

let maxOpen = MAX_OPEN_ADDRESSES;

/**
 * Replace the cap (tests: a small one, instead of opening 500 payments);
 * `null` restores {@link MAX_OPEN_ADDRESSES}. Answers the previous cap.
 */
export function useMaxOpenAddresses(next: number | null): number {
  const previous = maxOpen;
  maxOpen = next ?? MAX_OPEN_ADDRESSES;
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
  /** An address the chain showed unused just now, to claim in the transaction; else mint. */
  readonly candidate: RecycleCandidate | null;
}

export interface ReservedAddress {
  readonly recipientAccountId: string;
  readonly address: string;
  readonly derivationIndex: number;
  /** The key the address derives from, lowercase hex — recorded beside it (ADR 0002). */
  readonly identityPublicKey: string;
}

/**
 * Find an address of the recipient's to recycle — OUTSIDE any transaction,
 * because the chain read is an HTTP call. What it learns is kept: a candidate
 * that no longer derives from `identityPublicKey` or that the chain shows used
 * is retired here. An Explorer that cannot tell (`unknown`: an outage, or
 * testnet's node, which has no address index) ends the search — nothing is
 * recycled on a guess, and the reservation mints under the cap instead.
 */
export async function findRecyclableAddress(
  recipientAccountId: string,
  network: NetworkType,
  identityPublicKey: Uint8Array,
): Promise<RecycleCandidate | null> {
  const db = getDb();
  const candidates = await listRecycleCandidates(
    db,
    recipientAccountId,
    network,
    RECYCLE_QUARANTINE_SECONDS,
    CANDIDATE_BATCH,
  );
  const params = getNetwork(network);
  let chainChecks = 0;
  for (const candidate of candidates) {
    // A rotated key leaves addresses its wallet no longer derives (ADR 0002):
    // handing one out would pay a tree nobody scans.
    if (
      deriveSocialReceiveAddress(identityPublicKey, candidate.derivationIndex, params) !==
      candidate.address
    ) {
      await retireRecycleCandidate(db, candidate.id);
      continue;
    }
    if (chainChecks >= MAX_CHAIN_CHECKS) break;
    chainChecks += 1;
    const usage = await usageReader(candidate.address, network);
    if (usage === 'used') {
      await retireRecycleCandidate(db, candidate.id);
      continue;
    }
    if (usage === 'unknown') break;
    return candidate;
  }
  return null;
}

/**
 * Reserve every planned address in the payment's own transaction: the pools
 * are locked in one order (no two payments can wait on each other's), a
 * candidate is claimed by compare-and-swap, and otherwise — under the cap — the
 * next index is minted on the cursor. A rolled-back payment rolls its claims
 * and its mints back with it, so no address is lost to a payment that never
 * existed.
 *
 * @throws {FaircoinCapacityError} a recipient already has {@link MAX_OPEN_ADDRESSES} open.
 */
export async function reservePlannedAddresses(
  tx: DatabaseOrTransaction,
  plans: readonly PlannedAddress[],
): Promise<ReservedAddress[]> {
  const pools = [...new Set(plans.map((plan) => `${plan.network}\u0000${plan.recipientAccountId}`))]
    .sort()
    .map((key) => {
      const [network, recipientAccountId] = key.split('\u0000') as [NetworkType, string];
      return { network, recipientAccountId };
    });
  for (const pool of pools) await lockRecipientPool(tx, pool.recipientAccountId, pool.network);

  const reserved: ReservedAddress[] = [];
  for (const plan of plans) {
    if (plan.candidate && (await claimRecycleCandidate(tx, plan.candidate.id))) {
      reserved.push({
        recipientAccountId: plan.recipientAccountId,
        address: plan.candidate.address,
        derivationIndex: plan.candidate.derivationIndex,
        identityPublicKey: bytesToHex(plan.identityPublicKey),
      });
      continue;
    }
    const open = await countOpenAddresses(
      tx,
      plan.recipientAccountId,
      plan.network,
      RECYCLE_QUARANTINE_SECONDS,
    );
    if (open >= maxOpen) throw new FaircoinCapacityError();
    const identityPublicKey = bytesToHex(plan.identityPublicKey);
    const index = await reserveNextSocialReceiveIndex(
      tx,
      plan.recipientAccountId,
      plan.network,
      identityPublicKey,
    );
    reserved.push({
      recipientAccountId: plan.recipientAccountId,
      address: deriveSocialReceiveAddress(plan.identityPublicKey, index, getNetwork(plan.network)),
      derivationIndex: index,
      identityPublicKey,
    });
  }
  return reserved;
}

/**
 * Whether a new FairCoin payment to the recipient could get an address now —
 * the order page's answer (`temporarily_unavailable` when not). A recyclable
 * candidate counts as room; the confirm decides for certain, under the lock.
 */
export async function recipientHasAddressRoom(
  recipientAccountId: string,
  network: NetworkType,
): Promise<boolean> {
  const db = getDb();
  const open = await countOpenAddresses(
    db,
    recipientAccountId,
    network,
    RECYCLE_QUARANTINE_SECONDS,
  );
  if (open < maxOpen) return true;
  const candidates = await listRecycleCandidates(
    db,
    recipientAccountId,
    network,
    RECYCLE_QUARANTINE_SECONDS,
    1,
  );
  return candidates.length > 0;
}
