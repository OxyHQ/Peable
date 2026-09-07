/**
 * Pure entry-routing decision for `app/index.tsx`. Kept side-effect-free so the
 * whole decision table is unit-testable without a renderer (the screen only
 * reads auth/wallet state and renders the branch this returns).
 *
 * Order (spec §4.2): resolve auth → sign in with Oxy → (native) derive wallet
 * or route keyless accounts to create an Oxy ID → PIN gate → home.
 *
 * `read-only` is signed in WITH NO SPEND CAPABILITY — not an unsupported
 * platform. The identity seed derives from a key held in the on-device keystore
 * (`@oxyhq/core` keyManager — "never leave the device"), and a browser has no
 * equivalent, so it can never SIGN. Everything else needs no private key: the
 * balance and history are public chain data, the receive address derives from a
 * public xpub, and the payment history is the caller's own row in the gateway.
 *
 * The screen renders that surface IN PLACE rather than navigating to it. The
 * predecessor redirected to `/@you`, which put the browser on a screen whose
 * back arrow fell through to `(tabs)` — the wallet this branch exists to say is
 * impossible here.
 */

import type { IdentityInitResult } from "./wallet-store";

export type EntryRoute = {
  kind:
    | "loading"
    | "signin"
    | "create-identity"
    | "needs-pin"
    | "ready"
    | "read-only";
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
  if (identityInit === "no-keystore") return { kind: "read-only" };
  if (identityInit === "no-identity") return { kind: "create-identity" };

  // Wallet initialized: PIN gate before any authenticated screen (spec §7).
  if (hasPinConfigured === null) return { kind: "loading" };
  if (!hasPinConfigured) return { kind: "needs-pin" };
  return { kind: "ready" };
}
