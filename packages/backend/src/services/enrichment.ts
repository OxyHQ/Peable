import { oxyClient, getNormalizedUserHandle } from "@oxy.so/core";
import type { EnrichmentResult } from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import { findIntentsByAddresses } from "../db/payments/paymentIntentRepository";
import { findMerchantsByIds } from "../db/merchants/merchantRepository";
import { findAttributionsForViewer } from "../db/social/sendAttribution";

/** Hard cap on a single enrichment batch — enforced by the `POST /v1/enrich` route (Task 9). */
export const ENRICH_MAX_ADDRESSES = 50;

/**
 * Resolve display identity for a batch of the CALLER's own addresses (spec
 * §4.8) — "Paid at <merchant>" for a Gateway PaymentIntent receive address,
 * "Sent to @x" / "Received from @x" for a social-receive address the caller
 * was the sender or recipient of, else `unknown` (an honest external
 * on-chain payment, per spec §4.5). Display-only: never touches a private
 * key, never blocks a payment, degrades to `unknown` on any partial failure
 * to resolve a counterparty's profile.
 *
 * Every address defaults to `unknown` up front so the returned record always
 * has exactly one entry per input address, in every branch.
 */
export async function enrichAddresses(
  addresses: string[],
  viewerUserId: string,
): Promise<Record<string, EnrichmentResult>> {
  const result: Record<string, EnrichmentResult> = {};
  for (const address of addresses) {
    result[address] = { kind: "unknown" };
  }
  if (addresses.length === 0) {
    return result;
  }

  const db = getDb();

  // 1. Merchant payments — PaymentIntent.address -> Merchant display fields.
  // Both reads are BATCHED: one query for the intents behind up to
  // ENRICH_MAX_ADDRESSES addresses, then one for the merchants behind those
  // intents. Resolving the merchants one id at a time would be a 50-query N+1
  // on a path a wallet calls to render a transaction list.
  const intents = await findIntentsByAddresses(db, addresses);
  const merchantIdByAddress = new Map<string, string>();
  for (const intent of intents) {
    // `address` is nullable since ADR 0001 D6, and every row this query returns
    // matched one of the requested addresses — so a null here is unreachable
    // rather than an unhandled case. Skipping is still the right shape: a
    // non-null assertion would turn an impossible row into a crash on a
    // read-only display path a wallet calls to render a transaction list.
    if (intent.address === null) continue;
    merchantIdByAddress.set(intent.address, intent.merchantId);
  }
  const merchants = await findMerchantsByIds(db, [...new Set(merchantIdByAddress.values())]);
  const merchantById = new Map(merchants.map((m) => [m.id, m]));
  const resolvedAddresses = new Set<string>();
  for (const [address, merchantId] of merchantIdByAddress) {
    const merchant = merchantById.get(merchantId);
    if (!merchant) continue;
    result[address] = {
      kind: "merchant",
      displayName: merchant.displayName ?? undefined,
      avatarFileId: merchant.avatarFileId ?? undefined,
      description: merchant.description ?? undefined,
    };
    resolvedAddresses.add(address);
  }

  // 2. Social sends/receives — SocialSendAttribution, scoped to the VIEWER's
  // own side of the payment IN THE QUERY ITSELF (never leak a counterparty
  // for an address the caller wasn't party to — a row where the viewer is
  // neither sender nor recipient never leaves the database).
  const remaining = addresses.filter((a) => !resolvedAddresses.has(a));
  if (remaining.length > 0) {
    const attributions = await findAttributionsForViewer(db, remaining, viewerUserId);
    const counterpartyByAddress = new Map<string, string>();
    for (const attribution of attributions) {
      counterpartyByAddress.set(
        attribution.address,
        attribution.senderUserId === viewerUserId
          ? attribution.recipientUserId
          : attribution.senderUserId,
      );
    }

    if (counterpartyByAddress.size > 0) {
      const counterpartyIds = [...new Set(counterpartyByAddress.values())];
      const profiles = await oxyClient.getUsersByIds(counterpartyIds);
      const profileById = new Map(profiles.map((p) => [p.id, p]));
      for (const [address, counterpartyId] of counterpartyByAddress) {
        const profile = profileById.get(counterpartyId);
        if (!profile) continue;
        const handle = getNormalizedUserHandle(profile) ?? profile.username;
        result[address] = {
          kind: "user",
          displayName: profile.name.displayName ?? handle,
          avatarFileId: profile.avatar ?? undefined,
          username: profile.username,
        };
      }
    }
  }

  return result;
}
