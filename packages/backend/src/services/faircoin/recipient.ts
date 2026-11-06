/**
 * Who receives a FairCoin payment, on which network, and at which address
 * (ADR 0021 D5, amended 2026-11-06) — the ONE place that decides it.
 *
 * FairCoin paid to an Orbit merchant goes to the **Peable wallet of the Oxy
 * account that owns the merchant's application** (a person or an
 * organization); an on-behalf payment to the Peable wallet of the seller's own
 * account. There is no registered key: the address derives from the
 * recipient's PUBLIC identity key — its DID's `#key-1` — exactly as social
 * receive does (ADR 0002), on the recipient's ONE cursor, so merchant, seller
 * and `@username` payments to an account share one tree its wallet already
 * scans and can never be handed the same address. The private key lives on the
 * recipient's devices; Peable never holds one.
 *
 * Nothing here refuses an ORDER: a recipient without a wallet makes FairCoin
 * unavailable on it, with the reason (`faircoin_wallet_missing`), and the card
 * keeps working.
 */
import type { NetworkType } from '@fairco.in/core';
import type { CurrencyCode, FaircoinUnavailableReason } from '@peable.to/shared-types';
import type { ConnectedAccountRow } from '../../db/accounts/connectedAccountRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { config } from '../../config';
import { faircoinPriceAvailable } from './quote';
import { resolveIdentityPublicKey } from '../socialReceive';
import { type PlannedAddress, recipientHasAddressRoom } from './addressPool';

/** The recipient has no Peable wallet yet (no identity key), or is not known yet. */
export class FaircoinWalletMissingError extends Error {
  constructor(
    message = "the merchant's Peable wallet isn't set up yet, so it cannot be paid in FairCoin",
  ) {
    super(message);
    this.name = 'FaircoinWalletMissingError';
  }
}

/** This deployment does not mint identity addresses on `network` yet (ADR 0002's gate). */
export class FaircoinNetworkClosedError extends Error {
  constructor(network: NetworkType) {
    super(`FairCoin payments on ${network} are not open on this deployment yet`);
    this.name = 'FaircoinNetworkClosedError';
  }
}

/** A merchant's FairCoin network: its environment's (0092 backfilled every row). */
export function faircoinNetworkOf(merchant: {
  readonly network: NetworkType | null;
  readonly environment: MerchantRow['environment'];
}): NetworkType {
  return merchant.network ?? (merchant.environment === 'production' ? 'mainnet' : 'testnet');
}

/**
 * The Oxy account whose Peable wallet receives: the seller's own for an
 * on-behalf payment, the merchant's owner otherwise. `null` while the owner is
 * not known yet (no authenticated request has mirrored it).
 */
export function faircoinRecipientOf(
  merchant: Pick<MerchantRow, 'ownerAccountId'>,
  account?: Pick<ConnectedAccountRow, 'faircoinOxyUserId'> | null,
): string | null {
  if (account) return account.faircoinOxyUserId ?? null;
  return merchant.ownerAccountId ?? null;
}

/**
 * ADR 0002's deployment gate: `testnet` always mints; `mainnet` only where the
 * deployment says `PEABLE_SOCIAL_PAY_NETWORK=mainnet`. The SAME gate as
 * `@username` payments, because they are the same addresses.
 */
export function identityNetworkOpen(network: NetworkType): boolean {
  return network === 'testnet' || config.socialPayNetwork === 'mainnet';
}

/** Identity keys are public, cacheable DID reads; a short cache spares Oxy a read per page view. */
const KEY_REUSE_MS = 30_000;
const keyCache = new Map<string, { at: number; has: boolean }>();

async function hasIdentityKey(accountId: string): Promise<boolean> {
  const cached = keyCache.get(accountId);
  if (cached && Date.now() - cached.at < KEY_REUSE_MS) return cached.has;
  const has = (await resolveIdentityPublicKey(accountId)) !== null;
  // Only a present key is cached: a wallet created a moment ago must show at once.
  if (has) keyCache.set(accountId, { at: Date.now(), has });
  return has;
}

/**
 * Decide, before the payment's transaction, how the next address in the
 * recipient's Peable wallet will be reserved: the gates (network, wallet) and
 * the recipient's PUBLIC identity key, read fresh (an HTTP call, so outside the
 * transaction). The reservation itself — a fresh index on the cursor, under
 * the per-recipient unpaid bound (ADR 0021 D9) — is `reservePlannedAddresses`,
 * in the payment's transaction.
 *
 * @throws {FaircoinWalletMissingError} no recipient, or no identity key.
 * @throws {FaircoinNetworkClosedError} the deployment does not open `network`.
 */
export async function planFaircoinAddress(
  recipientAccountId: string | null,
  network: NetworkType,
): Promise<PlannedAddress> {
  if (!identityNetworkOpen(network)) throw new FaircoinNetworkClosedError(network);
  if (recipientAccountId === null) throw new FaircoinWalletMissingError();
  const identityPublicKey = await resolveIdentityPublicKey(recipientAccountId);
  if (!identityPublicKey) throw new FaircoinWalletMissingError();
  return { recipientAccountId, network, identityPublicKey };
}

/**
 * Whether a payer can choose FairCoin on an order now (ADR 0021): it is always
 * offered, and says why when it cannot be paid with — no wallet, a network the
 * deployment has not opened, or (a fiat order) no fresh price.
 */
export async function faircoinAvailability(order: {
  readonly network: NetworkType | null;
  readonly currency: CurrencyCode;
  readonly recipientAccountId: string | null;
}): Promise<{ available: boolean; unavailable_reason: FaircoinUnavailableReason | null }> {
  const unavailable = (reason: FaircoinUnavailableReason) => ({
    available: false,
    unavailable_reason: reason,
  });
  if (order.recipientAccountId === null || order.network === null) {
    return unavailable('faircoin_wallet_missing');
  }
  if (!identityNetworkOpen(order.network)) return unavailable('faircoin_network_closed');
  let hasKey: boolean;
  try {
    hasKey = await hasIdentityKey(order.recipientAccountId);
  } catch {
    // Oxy could not be asked: neither "no wallet" nor a guess — say so.
    return unavailable('temporarily_unavailable');
  }
  if (!hasKey) return unavailable('faircoin_wallet_missing');
  // Too many of the recipient's addresses of the last day went unpaid (ADR
  // 0021 D9): FairCoin waits, and says so. Display only — the confirm decides
  // under the pool's lock — so a count that cannot be read does not hide it.
  const room = await recipientHasAddressRoom(order.recipientAccountId, order.network).catch(
    () => true,
  );
  if (!room) return unavailable('temporarily_unavailable');
  if (order.currency !== 'FAIR' && !(await faircoinPriceAvailable(order.currency))) {
    return unavailable('price_unavailable');
  }
  return { available: true, unavailable_reason: null };
}
