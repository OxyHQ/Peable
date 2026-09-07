/**
 * The public `/@username` profile route (`peable.to/@john`) — segment parsing
 * and the pure decision for what its pay action may offer.
 *
 * Kept side-effect-free so the whole table is unit-testable without a
 * renderer, mirroring `wallet/entry-route.ts` for `app/index.tsx`.
 */

import { isValidUsername } from "@oxyhq/contracts";
import type { NetworkType } from "@fairco.in/core";
import { PROFILE_WEB_ORIGIN } from "../config";
import { SOCIAL_PAY_NETWORK } from "./social-network";

/**
 * Read the Oxy handle out of the route's `[username]` segment.
 *
 * expo-router hands the WHOLE segment through, `@` included, so `/@john`
 * arrives as `"@john"`. The `@` is what tells a profile URL apart from every
 * other unknown single-segment path that this root-level dynamic route also
 * matches: without the check, `/typo` would query the Oxy identity API for a
 * user named "typo" instead of rendering the app's 404. `isValidUsername` is
 * Oxy's own rule (`@oxyhq/core`), so anything this accepts is a handle the
 * identity API can actually be asked about, and everything else 404s locally
 * without a round trip.
 */
export function parseProfileHandle(
  segment: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(segment) ? segment[0] : segment;
  if (typeof raw !== "string" || !raw.startsWith("@")) return null;
  const handle = raw.slice(1);
  return isValidUsername(handle) ? handle : null;
}

/**
 * What the profile page's pay action can honestly offer right now.
 *
 * - `loading` — Oxy auth state is still resolving; don't flash a wrong CTA.
 * - `self` — the viewer is looking at their own profile. The gateway rejects
 *   this with a 422 ("cannot pay yourself"), so the page must not offer it.
 * - `web` — the wallet is native-only by design (`wallet-store.ts` returns
 *   `"web-unsupported"`): the seed derives from an on-device Oxy identity key
 *   that does not exist in a browser. A browser visitor is never asked to
 *   sign in, because signing in would not make paying possible.
 * - `signin` — native, signed out. Paying by handle needs the payer's OWN Oxy
 *   session: `POST /v1/social/:username/next_address` is authenticated and
 *   records the sender's attribution.
 * - `wallet-not-ready` — native, signed in, but no derived wallet yet
 *   (keyless account, or the identity wallet hasn't been brought up).
 * - `mainnet-blocked` — pay-by-@username has not cleared mainnet. Finding F-1:
 *   rotating the Oxy identity key desyncs the shared key slot, so a payer can
 *   send to addresses the recipient can neither see nor spend — silent,
 *   permanent loss. Testnet only until that is fixed upstream.
 * - `send` — everything holds; route into the send flow.
 *
 * `isSelf` is only meaningful once the profile has loaded, which is also the
 * only time the page renders a CTA at all — the screen shows its own loading
 * state until then, so this never sees a not-yet-known `false`.
 */
export type ProfilePayAction =
  | { kind: "loading" }
  | { kind: "self" }
  | { kind: "web" }
  | { kind: "signin" }
  | { kind: "wallet-not-ready" }
  | { kind: "mainnet-blocked" }
  | { kind: "send" };

export function decideProfilePayAction(input: {
  isWeb: boolean;
  isAuthResolved: boolean;
  isAuthenticated: boolean;
  isSelf: boolean;
  walletInitialized: boolean;
  network: NetworkType;
}): ProfilePayAction {
  const { isWeb, isAuthResolved, isAuthenticated, isSelf, walletInitialized, network } =
    input;

  if (!isAuthResolved) return { kind: "loading" };

  // Before the platform split: "this is you" is the useful answer in a browser
  // too, and it is true regardless of whether a wallet could exist there.
  if (isAuthenticated && isSelf) return { kind: "self" };

  // A browser cannot hold the on-device identity key the wallet seed derives
  // from, so no amount of signing in changes the answer.
  if (isWeb) return { kind: "web" };

  if (!isAuthenticated) return { kind: "signin" };
  if (!walletInitialized) return { kind: "wallet-not-ready" };

  // Last, so a testnet wallet that is merely signed out still reads "sign in"
  // rather than a network warning it cannot act on.
  //
  // The constant, not the literal: `ReadOnlyWalletView` asks the gateway for
  // payments on the same network this gate lets people send on, and when the
  // two were written separately they disagreed.
  if (network !== SOCIAL_PAY_NETWORK) return { kind: "mainnet-blocked" };

  return { kind: "send" };
}

/**
 * The shareable link for a handle — what `peable.to/@john` literally is.
 *
 * Built from `PROFILE_WEB_ORIGIN` rather than the current location so the same
 * string is produced on native, where there is no location to read, and in a
 * browser, where reading one would bake a preview deployment's hostname into a
 * QR someone photographs. Takes the BARE handle (no `@`) that
 * `parseProfileHandle` returns, and re-adds the prefix itself — the two
 * functions are the only places that know the URL shape.
 */
export function buildProfileUrl(handle: string): string {
  return `${PROFILE_WEB_ORIGIN}/@${handle}`;
}
