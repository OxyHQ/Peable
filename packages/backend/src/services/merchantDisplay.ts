import { oxyClient } from "@oxy.so/core";
import type { MerchantDisplay } from "@peable.to/shared-types";
import type { MerchantRow } from "../db/merchants/merchantRepository";

/** Neutral fallback shown when a merchant hasn't set a `displayName`. */
const DEFAULT_MERCHANT_NAME = "Peable merchant";

/**
 * Resolve the public, secret-free merchant identity that a payer-facing
 * surface (the hosted checkout page, a payment link's public display) may
 * render. Never touches `webhookUrl`/`webhookSecret`/`xpub` — those never
 * leave the merchant-authed DTO (`toMerchantDTO`).
 *
 * The avatar is resolved through the SDK's canonical media chokepoint
 * (`oxyClient.getFileDownloadUrl`, the same public-CDN URL builder every
 * other Oxy app uses for a public avatar — `'thumb'` is the ecosystem-wide
 * variant for this size of identity chip) rather than hand-building a
 * `cloud.oxy.so` string here. It is a synchronous, no-network builder, so
 * this function has no real await today; it stays `async` because the
 * caller-facing contract is `Promise<MerchantDisplay>` (matches
 * `MerchantDisplay`'s doc comment: "resolved server-side").
 */
export async function resolveMerchantDisplay(
  merchant: MerchantRow,
): Promise<MerchantDisplay> {
  return {
    name: merchant.displayName ?? DEFAULT_MERCHANT_NAME,
    avatarUrl: merchant.avatarFileId
      ? oxyClient.getFileDownloadUrl(merchant.avatarFileId, "thumb")
      : null,
    description: merchant.description ?? null,
  };
}
