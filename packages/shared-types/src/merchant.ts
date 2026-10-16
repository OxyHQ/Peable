// Merchant contract — the public DTO for a registered Gateway merchant.
// `webhookSecret` and `nextDerivationIndex` are deliberately NEVER included:
// the former is an HMAC signing secret, the latter an internal derivation
// counter with no meaning to a merchant integration.
import type { NetworkType } from './network';

export const MERCHANT_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type MerchantEnvironment = (typeof MERCHANT_ENVIRONMENTS)[number];

/**
 * A platform's own FairCoin fee key, as the platform may see it (ADR 0012 §D12):
 * which network it is on and when it was registered — never the key itself.
 * Registered only by a member of the merchant's Oxy application with
 * `billing:manage`, in the Peable wallet; the API never accepts one.
 */
export interface PlatformFeeAccount {
  network: NetworkType;
  registeredAt: string;
}

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
  /**
   * The platform's fee keys, one per network (ADR 0012 §D12). Present on
   * `GET /v1/merchants/me`; a fee-bearing payment on a network with none is
   * refused (`platform_fee_account_missing`).
   */
  feeAccounts?: PlatformFeeAccount[];
  /** Where the owner registers a fee key — the Peable wallet, signed in with Oxy. */
  feeAccountSetupUrl?: string;
  /**
   * Days from a fee accruing to it being past due, which restricts the seller
   * (ADR 0012 §D12). Platform setting, 1–365, default 30.
   */
  applicationFeeGraceDays?: number;
  createdAt: string;
  updatedAt: string;
}
