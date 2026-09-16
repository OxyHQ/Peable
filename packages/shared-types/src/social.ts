// Social-receive + transaction-enrichment contracts — shared by the Peable
// Gateway backend, the wallet frontend, and (indirectly) the enrichment
// service's callers. Mirrors the Stripe-parity style of paymentIntent.ts.

import type { NetworkType } from './network';

/**
 * Longest `SocialPaymentSource.app` the gateway accepts. An app slug, not a
 * label — 32 characters is more than any Oxy app id needs and short enough that
 * the column can never become a place to put prose.
 *
 * Published with the contract because it is what a request is REFUSED for: a
 * caller that cannot read the bound from the types finds it out with a 422.
 */
export const SOCIAL_SOURCE_APP_MAX_LENGTH = 32;

/**
 * Longest `SocialPaymentSource.ref` the gateway accepts.
 *
 * The bound is the whole defence here, because the value is opaque: Peable
 * never parses, resolves or links a `ref`, so nothing downstream would notice
 * it growing. 128 characters holds any id an app mints (a uuid, a snowflake, a
 * base64 hash) and refuses a payload.
 */
export const SOCIAL_SOURCE_REF_MAX_LENGTH = 128;

/**
 * Display-only context for one social payment: which app the payer was in, and
 * that app's own id for what the payment was for (a Mention post, say).
 *
 * **Opaque to Peable, by design.** `ref` is never parsed, resolved, joined or
 * shown to anyone but the two parties — the gateway stores a string and hands
 * the same string back. That is what keeps "tip a post" from widening what the
 * payment gateway knows about a user: it learns that an id exists, not what it
 * names. The app that minted the `ref` is the only thing that can resolve it,
 * and it already knows.
 *
 * It affects NOTHING about the money. The address a payer is shown comes from
 * the recipient's identity key and the reservation cursor, neither of which
 * this is an input to; a request carrying a source and one carrying none
 * reserve the same index.
 */
export interface SocialPaymentSource {
  /** The calling app, e.g. `'mention'`. At most {@link SOCIAL_SOURCE_APP_MAX_LENGTH} characters. */
  app: string;
  /**
   * That app's own opaque id for what the payment was for, e.g. a post id. At
   * most {@link SOCIAL_SOURCE_REF_MAX_LENGTH} characters. Absent when the app
   * has no single thing to name.
   */
  ref?: string;
}

/**
 * Body of `POST /v1/social/:username/next_address` (spec §4.4 step 3).
 *
 * `source` is OPTIONAL and stays that way: a plain person-to-person payment is
 * for nothing in particular, and a required field would make every caller
 * invent an answer.
 */
export interface SocialNextAddressRequest {
  network: NetworkType;
  source?: SocialPaymentSource;
}

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
  /**
   * The identity public key (hex) those addresses were derived from, as the
   * backend saw it. A device compares it with the key it derives from itself:
   * if they differ, its watch window is in the wrong tree and widening it only
   * watches more addresses nobody is paying into.
   *
   * `null` means exactly one thing: this caller has no cursor, so no address
   * has ever been reserved for them. Every cursor that exists names its key.
   */
  identityPublicKey: string | null;
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
  /**
   * What the payment was for, as the paying app named it at reservation time.
   * Absent for a plain person-to-person payment, which is most of them —
   * present only when the payer's app sent one, and never invented here.
   *
   * Display-only, exactly like `counterparty`: rendering it is all a client may
   * do with it, and a client that cannot resolve `source.ref` (because it is
   * not the app that minted it) shows the payment without the context rather
   * than dropping the payment.
   */
  source?: SocialPaymentSource;
  /** ISO-8601. When the address was minted, which is when the payment was set up. */
  createdAt: string;
}

/** Response of `GET /v1/social/me/payments`, newest first. */
export interface SocialPaymentsResponse {
  payments: SocialPayment[];
}
