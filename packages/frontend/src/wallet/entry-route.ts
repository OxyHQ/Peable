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
 * (`@oxy.so/core` keyManager — "never leave the device"), and a browser has no
 * equivalent, so it can never SIGN. Everything else needs no private key: the
 * balance and history are public chain data, the receive address derives from a
 * public xpub, and the payment history is the caller's own row in the gateway.
 *
 * The screen sends it into `(tabs)`, which admits the read-only capability
 * (`capability.ts`) and renders each tab's keyless branch. The first attempt
 * redirected to `/@you`, whose back arrow fell through to a `(tabs)` that then
 * admitted only an initialized wallet and bounced back; the second rendered in
 * place, outside the shell, and lost the navigation with it.
 */

import type { IdentityInitResult } from './wallet-store';

/**
 * Why the account the person acts as has no wallet to open on this host
 * (oxy ADRs 0001 and 0061): an organization whose wallet is not set up, not on
 * this phone, or not theirs to hold — or an account kind with no Peable
 * wallet at all. Rendered in place, like `create-identity`; the person's own
 * key is never used instead.
 */
export type WalletBlock =
  | {
      readonly kind: 'organization';
      readonly accountId: string;
      readonly status: 'keyless' | 'not-on-device' | 'forbidden' | 'unavailable';
    }
  | { readonly kind: 'unsupported' };

export type EntryRoute =
  | { kind: 'loading' | 'signin' | 'create-identity' | 'needs-pin' | 'ready' | 'read-only' }
  | { kind: 'blocked'; block: WalletBlock };

export function decideEntryRoute(input: {
  isAuthResolved: boolean;
  isAuthenticated: boolean;
  identityInit: IdentityInitResult | null;
  hasPinConfigured: boolean | null;
  block?: WalletBlock | null;
}): EntryRoute {
  const { isAuthResolved, isAuthenticated, identityInit, hasPinConfigured, block } = input;

  if (!isAuthResolved) return { kind: 'loading' };
  if (!isAuthenticated) return { kind: 'signin' };
  // Before the identity probe: a blocked account has no wallet to wait for.
  if (block) return { kind: 'blocked', block };

  // Signed in: the identity/wallet probe runs asynchronously; wait for it.
  if (identityInit === null || identityInit === 'superseded') return { kind: 'loading' };
  if (identityInit === 'no-keystore') return { kind: 'read-only' };
  if (identityInit === 'no-identity') return { kind: 'create-identity' };

  // Wallet initialized: PIN gate before any authenticated screen (spec §7).
  if (hasPinConfigured === null) return { kind: 'loading' };
  if (!hasPinConfigured) return { kind: 'needs-pin' };
  return { kind: 'ready' };
}
