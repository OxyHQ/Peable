// The seller-facing half of FairCoin connected accounts (ADR 0012 D3).
//
// A platform mints an onboarding link for a seller's account; the SELLER opens
// it signed in with Oxy and registers the watch-only key their FairCoin will be
// paid to. These are the shapes that page reads and writes. The platform never
// sees them and never supplies a key.
import type { MerchantDisplay } from './merchantDisplay';
import type { NetworkType } from './network';

/** `GET /v1/connect/onboarding/:token` — what the seller is being asked to do. */
export interface ConnectOnboarding {
  object: 'connect_onboarding';
  /** The `ca_…` being onboarded. */
  accountId: string;
  /** Who is asking — the PLATFORM's public display, as a payer would see it. */
  platform: MerchantDisplay;
  /** The chain the seller will be paid on. Their key must be for this network. */
  network: NetworkType;
  /** When this link stops working. */
  expiresAt: string;
  /** Where to send the seller once the key is registered. */
  returnUrl: string;
}

/** `POST /v1/connect/onboarding/:token/faircoin` — the seller's watch-only ACCOUNT xpub. */
export interface RegisterFaircoinKeyParams {
  /** A watch-only extended PUBLIC key. A private key is refused and never stored. */
  xpub: string;
}

/** The answer to a successful registration. */
export interface ConnectOnboardingComplete {
  object: 'connect_onboarding';
  accountId: string;
  status: 'active';
  returnUrl: string;
}

/**
 * A FairCoin onboarding link, as the platform receives it from
 * `POST /v1/connected_accounts/:id/account_links` with `rail: 'faircoin'`.
 * Same shape as the card rail's link. Do not store it: it is single-use and
 * expires — mint one when the seller is about to open it.
 */
export interface AccountLink {
  object: 'account_link';
  url: string;
  expiresAt: string;
}
