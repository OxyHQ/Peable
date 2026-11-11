<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# The web build is read-only, not unsupported

Only SIGNING is native-only, and the reason is narrow: the identity wallet's
seed derives from the identity key, whose holder is on the device (iOS: the
keychain group; Android: Commons over signature-protected IPC — Peable never
holds the key), and a browser has none. `hasIdentityKeystore()`
(`src/wallet/keystore.ts`, a `Platform.OS` proxy) answers that one question for
both `wallet-store.ts`'s `initializeFromIdentity` and the shell's capability
gate, and is the ONLY platform gate in the store — `createNewWallet`, `importWallet`
and `importWatchOnly` carry none, and `storage/kv-store.ts` has a real web
branch. Peable's fork deleted FAIRWallet's create/restore SCREENS (`4287418`),
not the capability.

Everything else a wallet shows needs no private key: balances and history are
public chain data, the receive address derives from a public identity key, and
`GET /v1/social/me/payments` answers by identity rather than by derived
addresses, which is the only payment view a keyless surface can ask for. So the
probe result is `"no-keystore"` and the route is `"read-only"`.

**Say what is absent, not which platform you are on — and gate the SHELL on
capability, never on `initialized`.** `src/wallet/capability.ts` decides
`full` / `read-only` / `pending` / `none`; `app/(tabs)/_layout.tsx` admits
`read-only`, and each tab renders its keyless branch (home activity, profile
receive code, settings without wallet sections). Send needs a key, so
the read-only rail and bar omit it and its screen redirects home. Currency
purchase screens are not part of Peable on any host.

Both wrong designs are easy to rebuild: naming the platform and redirecting
bounced off a `(tabs)` that admitted only an initialized wallet, and rendering
read-only in place on `app/index.tsx` left the browser outside the shell, with
no rail and no Settings.

**Never `<Redirect href="/" />` from inside `(tabs)`.** A route group adds no
URL segment, so `/` there resolves to `(tabs)/index`, the layout renders the
redirect again, and React aborts with error #185. The layout renders `SignInView` in place for `none` on
a keyless host instead. A keystore host is deliberately NOT gated there:
`lockWallet` drops `initialized` while the PIN overlay covers the shell, and a
gate would swap the tabs for sign-in underneath it.

The tab chrome is Bloom — `Rail` in a wide browser window, the floating
`TabBar` everywhere else — from one `expo-router/tabs` navigator on every
platform (harvested from FAIRWallet#9). The bar floats, so a tab screen clears
it with `useTabScreenBottomInset()`; a new tab that skips it hides its last row.

The public `/@username` profile (`app/(tabs)/[username].tsx`, also the 404
catch-all) is a bar-less route INSIDE that navigator, so a signed-in visitor
keeps the rail there. The gate lets it through for a signed-out payer and
renders no bar for them; moving it back to `app/` root drops the shell.
