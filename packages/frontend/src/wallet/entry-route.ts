/**
 * Pure entry-routing decision for `app/index.tsx`. Kept side-effect-free so the
 * whole decision table is unit-testable without a renderer (the screen only
 * reads auth/wallet state and renders the branch this returns).
 *
 * Order (spec §4.2): resolve auth → sign in with Oxy → (native) derive wallet
 * or route keyless accounts to create an Oxy ID → PIN gate → home.
 *
 * There is NO web branch here. A browser with a published account xpub is an
 * initialized wallet like any other, and goes to the same tabs through the same
 * PIN gate — same store, same screens, same everything. What a browser cannot
 * do is SIGN, and that is handled where signing happens, not at the door.
 *
 * `link-device` is the one genuinely web-shaped state, and it is about a missing
 * INPUT rather than a host: the address tree derives from a seed produced by
 * HKDF over the on-device identity private key, so a browser can only show the
 * wallet once the phone has published the public half. Two predecessors named
 * the host instead (`web-unsupported`, then `no-keystore`) and the screen acted
 * on them by rendering somewhere else — which is how the entry screen came to
 * redirect to `/@you` and strand the browser on a page whose back arrow fell
 * through into a wallet UI with no wallet behind it.
 */

import type { IdentityInitResult } from "./wallet-store";

export type EntryRoute = {
  kind:
    | "loading"
    | "signin"
    | "create-identity"
    | "needs-pin"
    | "ready"
    | "link-device";
};

export function decideEntryRoute(input: {
  isAuthResolved: boolean;
  isAuthenticated: boolean;
  identityInit: IdentityInitResult | null;
  hasPinConfigured: boolean | null;
}): EntryRoute {
  const { isAuthResolved, isAuthenticated, identityInit, hasPinConfigured } = input;

  if (!isAuthResolved) return { kind: "loading" };
  if (!isAuthenticated) return { kind: "signin" };

  // Signed in: the identity/wallet probe runs asynchronously; wait for it.
  if (identityInit === null) return { kind: "loading" };
  if (identityInit === "no-published-key") return { kind: "link-device" };
  if (identityInit === "no-identity") return { kind: "create-identity" };

  // Wallet initialized: PIN gate before any authenticated screen (spec §7).
  if (hasPinConfigured === null) return { kind: "loading" };
  if (!hasPinConfigured) return { kind: "needs-pin" };
  return { kind: "ready" };
}
