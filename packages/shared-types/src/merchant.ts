// Merchant contract — the public DTO for a registered Gateway merchant.
// `nextDerivationIndex` is deliberately NEVER included: it is an internal
// derivation counter with no meaning to a merchant integration. Where events
// are sent is not a merchant field: it is the `webhook_endpoint` resource.
import type { NetworkType } from './network';

export const MERCHANT_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type MerchantEnvironment = (typeof MERCHANT_ENVIRONMENTS)[number];

export interface Merchant {
  id: string;
  object: 'merchant';
  /**
   * Which of the provider's two worlds this object belongs to (ADR 0017):
   * `true` for a `production` merchant, `false` for every other environment.
   */
  livemode: boolean;
  oxy_app_id: string;
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
  required_confirmations: number;
  /**
   * Payer-facing branding. Absent when unset — `MerchantDisplay` is what a
   * payer surface renders, and it substitutes a neutral fallback; these are
   * the raw values the merchant owns.
   */
  display_name?: string;
  /**
   * Bare Oxy file id, not a URL. `MerchantDisplay.avatarUrl` resolves it.
   * Absent again once Oxy reports the file deleted or taken down.
   */
  avatar_file_id?: string;
  description?: string;
  created: number;
  updated_at: number;
}
