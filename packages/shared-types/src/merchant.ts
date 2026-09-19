// Merchant contract — the public DTO for a registered Gateway merchant.
// `webhookSecret` and `nextDerivationIndex` are deliberately NEVER included:
// the former is an HMAC signing secret, the latter an internal derivation
// counter with no meaning to a merchant integration.
import type { NetworkType } from './network';

export const MERCHANT_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type MerchantEnvironment = (typeof MERCHANT_ENVIRONMENTS)[number];

export interface Merchant {
  id: string;
  object: 'merchant';
  oxyAppId: string;
  environment: MerchantEnvironment;
  /**
   * The FairCoin chain this merchant accepts on — `null` on a CARD-ONLY
   * merchant.
   *
   * Nullable TOGETHER with `xpub`: they are two halves of one capability, and
   * the gateway refuses a registration carrying only one. Registration used to
   * demand both unconditionally, so a merchant who only wanted to take cards
   * had to supply a watch-only key for a chain they never intended to use.
   */
  network: NetworkType | null;
  /** `null` on a card-only merchant. Nullable together with `network`. */
  xpub: string | null;
  webhookUrl?: string;
  requiredConfirmations: number;
  /**
   * Payer-facing branding. Absent when unset — `MerchantDisplay` is what a
   * payer surface renders, and it substitutes a neutral fallback; these are
   * the raw values the merchant owns.
   */
  displayName?: string;
  /** Bare Oxy file id, not a URL. `MerchantDisplay.avatarUrl` resolves it. */
  avatarFileId?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}
