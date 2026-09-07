// Social-receive + transaction-enrichment contracts — shared by the Peable
// Gateway backend, the wallet frontend, and (indirectly) the enrichment
// service's callers. Mirrors the Stripe-parity style of paymentIntent.ts.

/** Response of `POST /v1/social/:username/next_address` (spec §4.4 step 3). */
export interface SocialNextAddressResponse {
  address: string;
  index: number;
}

/**
 * Response of `GET /v1/social/me/cursor` — lets the authenticated user's
 * device resync its social-receive watch window against the backend's
 * reservation cursor. `reserveNextSocialAddress` advances a MONOTONIC index
 * on every `next_address` call regardless of whether the reserved address is
 * ever paid, but a receiving device only widens its watch window when a
 * payment lands on an index it already watches — so a burst of reservations
 * with no payment in between (griefing, or a payer browsing/re-picking a
 * recipient) can silently outrun the device. Calling this endpoint tells the
 * device how far to widen: watch `0..reservedThrough+gap`.
 */
export interface SocialReceiveCursorResponse {
  /**
   * Highest social-receive index the backend has EVER reserved for the
   * caller, for the queried network. `0` when the caller has never had an
   * address reserved (no cursor exists yet) — mirrors
   * `SOCIAL_RECEIVE_FIRST_FRESH_INDEX - 1`, since index 0 itself is the
   * caller's stable default address and is never reserved through this flow.
   */
  reservedThrough: number;
}

/** Where a transaction's counterparty identity came from (spec §4.8). */
export type EnrichmentKind = 'merchant' | 'user' | 'unknown';

/**
 * Display-only counterparty identity for one address/txid, resolved by
 * `POST /v1/enrich`. Never affects custody; a failed/partial resolution
 * degrades to `{ kind: 'unknown' }`.
 */
export interface EnrichmentResult {
  kind: EnrichmentKind;
  /** Merchant name or user's `name.displayName ?? handle`. */
  displayName?: string;
  /** Bare Oxy file id — render via the canonical media chokepoint, never a URL. */
  avatarFileId?: string;
  /** Present for `kind: 'user'` only. */
  username?: string;
  /** Present for `kind: 'merchant'` only. */
  description?: string;
}

export interface EnrichRequest {
  addresses: string[];
}

export interface EnrichResponse {
  data: Record<string, EnrichmentResult>;
}

/** Which side of a social payment the caller was on. */
export type SocialPaymentDirection = 'sent' | 'received';

/**
 * One social payment as the CALLER saw it, for `GET /v1/social/me/payments`.
 *
 * The address-free view, and the only payment history a surface without a key
 * can ask for: deriving addresses needs a seed, so a browser cannot use the
 * address-list endpoints (`POST /v1/enrich`, the cursor) at all. `direction` is
 * the field that cannot be recovered from the address alone — the backend knows
 * it because the attribution names both parties, and resolving it here is what
 * keeps the caller from having to learn its own user id to compare against.
 *
 * Carries NO amount. An attribution records which address was minted for a
 * payment relationship, not what was paid; the amount lives on-chain, and the
 * client reads it from the Explorer against `address`.
 */
export interface SocialPayment {
  /** The single-use social-receive address minted for this payment. */
  address: string;
  direction: SocialPaymentDirection;
  /**
   * The other party. Reuses the enrichment contract, including its degradation:
   * a failed identity lookup answers `{ kind: 'unknown' }` rather than dropping
   * the payment, so a history never silently loses rows to an Oxy outage.
   */
  counterparty: EnrichmentResult;
  /** ISO-8601. When the address was minted, which is when the payment was set up. */
  createdAt: string;
}

/** Response of `GET /v1/social/me/payments`, newest first. */
export interface SocialPaymentsResponse {
  payments: SocialPayment[];
}
