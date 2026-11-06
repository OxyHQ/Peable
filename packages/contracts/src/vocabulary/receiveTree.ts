/**
 * The size of a recipient's FairCoin receive tree (ADR 0021 D9, amended
 * 2026-11-06) — ONE answer, read by the gateway that hands out indices and by
 * the Peable wallet that watches them.
 *
 * Every FairCoin address the gateway reserves for an account — a merchant
 * payment, a marketplace seller's, an invoice's, `@username` — is index `i` of
 * that account's identity tree (ADR 0002, ADR 0021 D5). The wallet watches a
 * contiguous window, indices `0 .. SOCIAL_RECEIVE_MAX_WATCHED - 1`, reaching
 * {@link SOCIAL_RECEIVE_GAP_LIMIT} past the highest index reserved
 * (`planSocialReceiveWindow` in `packages/frontend/src/wallet/social-receive.ts`),
 * and stops offering `@username` once that reach would pass its bound. So an
 * index is reserved only when the wallet, after reserving it, still reaches
 * the gap above it inside its bound:
 *
 *     index + SOCIAL_RECEIVE_GAP_LIMIT  <=  SOCIAL_RECEIVE_MAX_WATCHED - 1
 *     index                             <   SOCIAL_RECEIVE_INDEX_LIMIT
 *
 * The gateway refuses to mint `index >= SOCIAL_RECEIVE_INDEX_LIMIT` (in the
 * reservation's own statement), so every address it hands out is inside the
 * window the wallet watches. Zod-free and dependency-free: the wallet bundles
 * this module alone (`@peable.to/contracts/vocabulary/receiveTree`).
 */

/** The most indices the wallet watches: `0 .. SOCIAL_RECEIVE_MAX_WATCHED - 1`. */
export const SOCIAL_RECEIVE_MAX_WATCHED = 2_000;

/**
 * How many unused addresses the wallet watches beyond the highest index used
 * or reserved — the FairCoin BIP44 external-chain gap limit.
 */
export const SOCIAL_RECEIVE_GAP_LIMIT = 20;

/**
 * The first index the gateway never mints (exclusive bound): `1 980`. Every
 * minted index `i` satisfies `i < SOCIAL_RECEIVE_INDEX_LIMIT`, i.e.
 * `i + SOCIAL_RECEIVE_GAP_LIMIT <= SOCIAL_RECEIVE_MAX_WATCHED - 1`.
 */
export const SOCIAL_RECEIVE_INDEX_LIMIT = SOCIAL_RECEIVE_MAX_WATCHED - SOCIAL_RECEIVE_GAP_LIMIT;

/**
 * How close to {@link SOCIAL_RECEIVE_INDEX_LIMIT} a tree is "nearly full":
 * Orbit warns the owners once fewer fresh indices than this are left.
 */
export const SOCIAL_RECEIVE_NEARLY_FULL_REMAINING = 200;
