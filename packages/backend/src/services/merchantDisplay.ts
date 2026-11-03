import { oxy } from '../oxy';
import type { MerchantDisplay } from '@peable.to/shared-types';
import type { MerchantRow } from '../db/merchants/merchantRepository';

/** Neutral fallback shown when a merchant hasn't set a `displayName`. */
const DEFAULT_MERCHANT_NAME = 'Peable merchant';

/**
 * Resolve the public, secret-free merchant identity that a payer-facing
 * surface (the hosted checkout page, a payment link's public display) may
 * render. Never touches `xpub` or `nextDerivationIndex` — those never
 * leave the merchant-authed DTO (`toMerchantDTO`).
 *
 * The avatar is resolved through the SDK's canonical media chokepoint
 * (`oxy.assets.publicUrl`, the same public-CDN URL builder every
 * other Oxy app uses for a public avatar — `'thumb'` is the ecosystem-wide
 * variant for this size of identity chip) rather than hand-building a
 * `cloud.oxy.so` string here. It is a synchronous, no-network builder, so
 * this function has no real await today; it stays `async` because the
 * caller-facing contract is `Promise<MerchantDisplay>` (matches
 * `MerchantDisplay`'s doc comment: "resolved server-side").
 */
export async function resolveMerchantDisplay(merchant: MerchantRow): Promise<MerchantDisplay> {
  return {
    name: merchant.displayName ?? DEFAULT_MERCHANT_NAME,
    // A withheld avatar is one Oxy has said it will not serve right now (its
    // owner trashed it or made it private — `services/oxyFiles/fileEvents.ts`).
    // A URL to it would be a broken image on the checkout page.
    avatar_url:
      merchant.avatarFileId && merchant.avatarWithheld === null
        ? oxy.assets.publicUrl(merchant.avatarFileId, 'thumb')
        : null,
    // The wordmark, the same way: only a File Oxy is serving right now. The
    // original rather than a thumbnail — a logo is shown at its own size.
    logo_url: merchant.businessLogoOxyFileId
      ? oxy.assets.publicUrl(merchant.businessLogoOxyFileId)
      : null,
    description: merchant.description ?? null,
  };
}
