/**
 * What the wallet shell may show on this host, decided in one place.
 *
 * `app/(tabs)` used to admit only an INITIALIZED wallet, and a browser can
 * never initialize one (no keystore, so no identity seed). The read-only
 * surface therefore rendered outside the shell, and a web visitor lost the
 * navigation rail, Settings and every other tab with it. The shell now admits
 * both capabilities and each tab renders the branch this returns:
 *
 *   full       an initialized wallet: every tab works
 *   read-only  signed in on a host with no identity keystore: everything that
 *              needs no private key (activity, receive code, settings)
 *   pending    keyless host, auth not resolved yet — render nothing rather
 *              than bouncing a deep link (`/settings`) back to `/`
 *   none       no shell for this viewer: on a keyless host that means signed
 *              out, and the tabs layout renders sign-in in place
 *
 * Pure so the table is unit-testable; `use-wallet-capability.ts` feeds it.
 */

export type WalletCapability = "full" | "read-only" | "pending" | "none";

export function decideWalletCapability(input: {
  walletInitialized: boolean;
  hasIdentityKeystore: boolean;
  isAuthResolved: boolean;
  isAuthenticated: boolean;
}): WalletCapability {
  const { walletInitialized, hasIdentityKeystore, isAuthResolved, isAuthenticated } = input;

  if (walletInitialized) return "full";

  // A host WITH a keystore reaches the shell only through `app/index.tsx`,
  // which initializes the wallet (and passes the PIN gate) first. Admitting it
  // uninitialized would open a wallet UI with no wallet behind it.
  if (hasIdentityKeystore) return "none";

  if (!isAuthResolved) return "pending";
  return isAuthenticated ? "read-only" : "none";
}
