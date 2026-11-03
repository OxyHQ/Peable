// The public, secret-free merchant identity the hosted checkout page and the
// browser embed render. Never carries `webhookUrl`/`webhookSecret`/`xpub` —
// see `Merchant`'s doc comment for the full non-custody-adjacent rationale.
export interface MerchantDisplay {
  /** `Merchant.displayName`, or a neutral fallback when unset. */
  name: string;
  /** Resolved server-side via the canonical media chokepoint; `null` when the merchant has no avatar. */
  avatar_url: string | null;
  description: string | null;
}
